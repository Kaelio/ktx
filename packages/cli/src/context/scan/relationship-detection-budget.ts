export type KtxRelationshipDetectionStopReason = 'budget' | 'aborted';

export interface KtxRelationshipDetectionBudget {
  /**
   * Returns a stop reason when the relationship stage must stop scheduling new
   * work, else null. Calling it at a unit boundary records the first observed
   * stop so the stage can be finalized as partial.
   */
  check(): KtxRelationshipDetectionStopReason | null;
  /** The first stop reason observed via check(), or null if the stage ran to completion. */
  stopReason(): KtxRelationshipDetectionStopReason | null;
}

export interface CreateKtxRelationshipDetectionBudgetInput {
  budgetMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

export function createKtxRelationshipDetectionBudget(
  input: CreateKtxRelationshipDetectionBudgetInput,
): KtxRelationshipDetectionBudget {
  const now = input.now ?? (() => Date.now());
  const deadline = now() + Math.max(0, input.budgetMs);
  let tripped: KtxRelationshipDetectionStopReason | null = null;
  return {
    check() {
      if (input.signal?.aborted) {
        tripped = 'aborted';
        return 'aborted';
      }
      if (now() >= deadline) {
        tripped ??= 'budget';
        return 'budget';
      }
      return null;
    },
    stopReason() {
      return tripped;
    },
  };
}

export interface MapWithBudgetInput<TInput, TOutput> {
  inputs: readonly TInput[];
  concurrency: number;
  budget?: KtxRelationshipDetectionBudget;
  onStart?: (index: number, total: number, item: TInput) => Promise<void> | void;
  mapOne: (item: TInput, index: number) => Promise<TOutput>;
}

export interface MapWithBudgetResult<TOutput> {
  /** Output aligned with inputs; entries skipped on budget exhaustion are undefined. */
  results: Array<TOutput | undefined>;
  processedCount: number;
}

/**
 * Concurrent map that stops claiming new items once the budget trips. In-flight
 * items finish; pending items are left undefined. With no budget it is a plain
 * bounded-concurrency map.
 */
export async function mapWithBudget<TInput, TOutput>(
  input: MapWithBudgetInput<TInput, TOutput>,
): Promise<MapWithBudgetResult<TOutput>> {
  const total = input.inputs.length;
  const results: Array<TOutput | undefined> = new Array(total);
  const safeConcurrency = Math.max(1, Math.floor(input.concurrency));
  let nextIndex = 0;
  let processedCount = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      if (index >= total) {
        return;
      }
      // Check the budget only when work remains, so a deadline that elapses
      // after the last item is claimed never marks a fully-processed stage partial.
      if (input.budget?.check()) {
        return;
      }
      nextIndex += 1;
      const item = input.inputs[index] as TInput;
      await input.onStart?.(index, total, item);
      results[index] = await input.mapOne(item, index);
      processedCount += 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeConcurrency, total) }, () => worker()));
  return { results, processedCount };
}
