import { createAbortError, throwIfAborted } from '../core/abort.js';

export type RateLimitProvider = 'claude-subscription' | 'anthropic-api' | 'vertex' | 'codex' | 'openai-compatible';
type RateLimitSignalStatus = 'allowed' | 'warning' | 'rejected';

export interface RateLimitSignal {
  provider: RateLimitProvider;
  status: RateLimitSignalStatus;
  resetAtMs?: number;
  retryAfterMs?: number;
  utilization?: number;
  rateLimitType?: string;
}

export interface RateLimitRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface RateLimitGovernorConfig {
  enabled: boolean;
  maxConcurrency: number;
  throttleThreshold: number;
  minConcurrencyUnderPressure: number;
  maxWaitMs?: number;
  waitStateTickMs: number;
  retry: RateLimitRetryConfig;
}

export type RateLimitWaitState =
  | {
      kind: 'rate_limit_observed';
      provider: RateLimitProvider;
      status: RateLimitSignalStatus;
      rateLimitType?: string;
      resetAtMs?: number;
      retryAfterMs?: number;
      utilization?: number;
    }
  | {
      kind: 'concurrency_adjusted';
      provider: RateLimitProvider;
      from: number;
      to: number;
      reason: string;
      rateLimitType?: string;
      utilization?: number;
    }
  | {
      kind: 'wait_started' | 'wait_tick' | 'wait_finished';
      provider: RateLimitProvider;
      rateLimitType?: string;
      resumeAtMs: number;
      remainingMs: number;
    };

export interface RateLimitGovernorDeps {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export type RateLimitRelease = () => void;
type Subscriber = (state: RateLimitWaitState) => void;

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(createAbortError());
      },
      { once: true },
    );
  });

export function createRateLimitGovernorConfig(
  input: Partial<RateLimitGovernorConfig> & { retry?: Partial<RateLimitRetryConfig> } = {},
): RateLimitGovernorConfig {
  return {
    enabled: input.enabled ?? true,
    maxConcurrency: input.maxConcurrency ?? 1,
    throttleThreshold: input.throttleThreshold ?? 0.8,
    minConcurrencyUnderPressure: input.minConcurrencyUnderPressure ?? 1,
    ...(input.maxWaitMs !== undefined ? { maxWaitMs: input.maxWaitMs } : {}),
    waitStateTickMs: input.waitStateTickMs ?? 1_000,
    retry: {
      maxAttempts: input.retry?.maxAttempts ?? 6,
      baseDelayMs: input.retry?.baseDelayMs ?? 1_000,
      maxDelayMs: input.retry?.maxDelayMs ?? 60_000,
      jitter: input.retry?.jitter ?? true,
    },
  };
}

export class RateLimitGovernor {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly subscribers = new Set<Subscriber>();
  private waiters: Array<() => void> = [];
  private active = 0;
  private effectiveLimit: number;
  private pausedUntilMs: number | null = null;
  private pausedProvider: RateLimitProvider | null = null;
  private pausedRateLimitType: string | undefined;
  private pausedTickMs: number | null = null;
  private opaqueAttempts = new Map<RateLimitProvider, number>();
  private pauseGeneration = 0;
  private visibleWaitAbort: AbortController | null = null;

  constructor(
    private readonly config: RateLimitGovernorConfig,
    deps: RateLimitGovernorDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.effectiveLimit = Math.max(1, config.maxConcurrency);
  }

  currentLimit(): number {
    return this.config.enabled ? this.effectiveLimit : this.config.maxConcurrency;
  }

  /**
   * Total attempts a runtime should make for a single rate-limited LLM call,
   * including the first try. Returns 1 (no outer retry) when pacing is disabled:
   * the outer retry loop only exists to cooperate with this governor's pause, so
   * without active pacing there is no backoff to apply and the backend's own
   * retry handles transient rejections.
   */
  maxRetryAttempts(): number {
    return this.config.enabled ? Math.max(1, this.config.retry.maxAttempts) : 1;
  }

  activeSlots(): number {
    return this.active;
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    if (this.pausedUntilMs !== null) {
      this.startVisibleWaitTicker();
    }
    return () => {
      this.subscribers.delete(cb);
      if (this.subscribers.size === 0) {
        this.stopVisibleWaitTicker();
        this.wakeWaiters();
      }
    };
  }

  report(signal: RateLimitSignal): void {
    if (!this.config.enabled) {
      return;
    }
    this.emit({
      kind: 'rate_limit_observed',
      provider: signal.provider,
      status: signal.status,
      ...(signal.rateLimitType ? { rateLimitType: signal.rateLimitType } : {}),
      ...(signal.resetAtMs !== undefined ? { resetAtMs: signal.resetAtMs } : {}),
      ...(signal.retryAfterMs !== undefined ? { retryAfterMs: signal.retryAfterMs } : {}),
      ...(signal.utilization !== undefined ? { utilization: signal.utilization } : {}),
    });

    if (signal.status === 'rejected') {
      this.applyPause(signal);
      return;
    }

    if (signal.status === 'warning' || (signal.utilization ?? 0) >= this.config.throttleThreshold) {
      this.adjustLimit(Math.max(1, this.config.minConcurrencyUnderPressure), signal, 'provider pressure');
      return;
    }

    this.opaqueAttempts.delete(signal.provider);
    if ((signal.utilization ?? 0) < this.config.throttleThreshold) {
      this.adjustLimit(Math.max(1, this.config.maxConcurrency), signal, 'provider recovered');
    }
  }

  async waitForReady(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!this.config.enabled) {
      return;
    }
    await this.waitForPause(signal);
    throwIfAborted(signal);
  }

  async acquireWorkSlot(signal?: AbortSignal): Promise<RateLimitRelease> {
    throwIfAborted(signal);
    if (!this.config.enabled) {
      this.active += 1;
      return () => {
        this.active -= 1;
      };
    }

    while (true) {
      throwIfAborted(signal);
      await this.waitForPause(signal);
      throwIfAborted(signal);
      if (this.active < this.effectiveLimit) {
        this.active += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.wakeWaiters();
        };
      }
      await this.waitForSlot(signal);
    }
  }

  private applyPause(signal: RateLimitSignal): void {
    const resumeAtMs = this.resumeAtMsFor(signal);
    const boundedResumeAtMs =
      this.config.maxWaitMs === undefined ? resumeAtMs : Math.min(resumeAtMs, this.now() + this.config.maxWaitMs);
    if (this.pausedUntilMs === null || boundedResumeAtMs > this.pausedUntilMs) {
      this.pausedUntilMs = boundedResumeAtMs;
      this.pausedProvider = signal.provider;
      this.pausedRateLimitType = signal.rateLimitType;
      this.pausedTickMs = signal.rateLimitType === 'opaque' ? Math.max(1, boundedResumeAtMs - this.now()) : null;
      this.emitWait('wait_started');
      this.startVisibleWaitTicker();
      this.wakeWaiters();
    }
    this.adjustLimit(Math.max(1, this.config.minConcurrencyUnderPressure), signal, 'provider rejected');
  }

  private resumeAtMsFor(signal: RateLimitSignal): number {
    if (signal.resetAtMs !== undefined) {
      return signal.resetAtMs;
    }
    if (signal.retryAfterMs !== undefined) {
      return this.now() + signal.retryAfterMs;
    }
    const attempts = this.opaqueAttempts.get(signal.provider) ?? 0;
    this.opaqueAttempts.set(signal.provider, Math.min(attempts + 1, this.config.retry.maxAttempts));
    const base = Math.min(
      this.config.retry.maxDelayMs,
      this.config.retry.baseDelayMs * 2 ** Math.min(attempts, this.config.retry.maxAttempts - 1),
    );
    const jitterMultiplier = this.config.retry.jitter ? 0.75 + this.random() * 0.5 : 1;
    return this.now() + Math.round(base * jitterMultiplier);
  }

  private adjustLimit(to: number, signal: RateLimitSignal, reason: string): void {
    const bounded = Math.max(1, Math.min(this.config.maxConcurrency, to));
    if (bounded === this.effectiveLimit) {
      return;
    }
    const from = this.effectiveLimit;
    this.effectiveLimit = bounded;
    this.emit({
      kind: 'concurrency_adjusted',
      provider: signal.provider,
      from,
      to: bounded,
      reason,
      ...(signal.rateLimitType ? { rateLimitType: signal.rateLimitType } : {}),
      ...(signal.utilization !== undefined ? { utilization: signal.utilization } : {}),
    });
    this.wakeWaiters();
  }

  private startVisibleWaitTicker(): void {
    if (this.subscribers.size === 0 || this.pausedUntilMs === null) {
      return;
    }
    this.stopVisibleWaitTicker();
    const generation = (this.pauseGeneration += 1);
    const controller = new AbortController();
    this.visibleWaitAbort = controller;
    void this.runVisibleWaitTicker(generation, controller.signal).catch(() => undefined);
  }

  private stopVisibleWaitTicker(): void {
    this.visibleWaitAbort?.abort();
    this.visibleWaitAbort = null;
  }

  private async runVisibleWaitTicker(generation: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && generation === this.pauseGeneration && this.pausedUntilMs !== null) {
      const remainingMs = this.pausedUntilMs - this.now();
      if (remainingMs <= 0) {
        this.finishPause(generation);
        return;
      }
      this.emitWait('wait_tick');
      await this.sleep(Math.min(this.pausedTickMs ?? this.config.waitStateTickMs, remainingMs), signal);
    }
  }

  private finishPause(generation?: number): void {
    if (generation !== undefined && generation !== this.pauseGeneration) {
      return;
    }
    this.emitWait('wait_finished');
    this.pausedUntilMs = null;
    this.pausedProvider = null;
    this.pausedRateLimitType = undefined;
    this.pausedTickMs = null;
    this.stopVisibleWaitTicker();
    this.wakeWaiters();
  }

  private async waitForPause(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    while (this.pausedUntilMs !== null) {
      const remainingMs = this.pausedUntilMs - this.now();
      if (remainingMs <= 0) {
        this.finishPause();
        return;
      }
      if (this.visibleWaitAbort !== null) {
        await this.waitForSlot(signal);
      } else {
        await this.sleep(Math.min(this.pausedTickMs ?? this.config.waitStateTickMs, remainingMs), signal);
      }
      throwIfAborted(signal);
    }
  }

  private waitForSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    return new Promise((resolve, reject) => {
      const wake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(createAbortError());
      };
      const cleanup = () => {
        this.waiters = this.waiters.filter((candidate) => candidate !== wake);
        signal?.removeEventListener('abort', onAbort);
      };
      this.waiters.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private wakeWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private emitWait(kind: Extract<RateLimitWaitState['kind'], 'wait_started' | 'wait_tick' | 'wait_finished'>): void {
    if (this.pausedUntilMs === null || this.pausedProvider === null) {
      return;
    }
    this.emit({
      kind,
      provider: this.pausedProvider,
      ...(this.pausedRateLimitType ? { rateLimitType: this.pausedRateLimitType } : {}),
      resumeAtMs: this.pausedUntilMs,
      remainingMs: Math.max(0, this.pausedUntilMs - this.now()),
    });
  }

  private emit(state: RateLimitWaitState): void {
    for (const subscriber of this.subscribers) {
      subscriber(state);
    }
  }
}
