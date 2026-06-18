import { describe, expect, it, vi } from 'vitest';
import type { KtxSetupAgentsResult } from '../src/setup-agents.js';
import {
  buildDemoReplayTimeline,
  DEMO_REPLAY_TARGETS,
  renderDemoAgentTransition,
  renderDemoBanner,
  renderDemoCardContent,
  renderDemoCompletionSummary,
  runDemoTour,
} from '../src/setup-demo-tour.js';

/** Strip ANSI escape sequences for plain-text assertions. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('renderDemoBanner', () => {
  it('contains "Demo mode"', () => {
    const plain = stripAnsi(renderDemoBanner());
    expect(plain).toContain('Demo mode');
  });

  it('mentions pre-processed data', () => {
    const plain = stripAnsi(renderDemoBanner());
    expect(plain).toContain('pre-processed');
  });

  it('mentions read-only', () => {
    const plain = stripAnsi(renderDemoBanner());
    expect(plain).toContain('read-only');
  });
});

describe('renderDemoCardContent', () => {
  it('contains the title', () => {
    const plain = stripAnsi(renderDemoCardContent('Database connection', ['Postgres']));
    expect(plain).toContain('Database connection');
  });

  it('contains each selection', () => {
    const plain = stripAnsi(renderDemoCardContent('Sources', ['dbt', 'metabase']));
    expect(plain).toContain('dbt');
    expect(plain).toContain('metabase');
  });

  it('contains navigation hints', () => {
    const plain = stripAnsi(renderDemoCardContent('Title', ['a']));
    expect(plain).toContain('Press Enter to continue');
    expect(plain).toContain('Escape to go back');
  });

  it('works with multiple selections', () => {
    const result = renderDemoCardContent('Pick', ['one', 'two', 'three']);
    const plain = stripAnsi(result);
    expect(plain).toContain('one');
    expect(plain).toContain('two');
    expect(plain).toContain('three');
    // Each selection gets a ▸ bullet
    const bullets = (plain.match(/▸/g) ?? []).length;
    expect(bullets).toBe(3);
  });
});

describe('renderDemoAgentTransition', () => {
  it('contains "Demo project is ready"', () => {
    const plain = stripAnsi(renderDemoAgentTransition());
    expect(plain).toContain('Demo project is ready');
  });

  it('mentions connecting an agent', () => {
    const plain = stripAnsi(renderDemoAgentTransition());
    expect(plain).toContain('connect your agent');
  });
});

describe('renderDemoCompletionSummary', () => {
  const projectDir = '/tmp/ktx-demo-123';

  it('includes the project path', () => {
    const plain = stripAnsi(renderDemoCompletionSummary(projectDir, true));
    expect(plain).toContain(projectDir);
  });

  it('includes a temp directory warning', () => {
    const plain = stripAnsi(renderDemoCompletionSummary(projectDir, true));
    expect(plain).toContain('temporary directory');
  });

  it('points to ktx setup for real data', () => {
    const plain = stripAnsi(renderDemoCompletionSummary(projectDir, true));
    expect(plain).toContain('ktx setup');
  });

  it('shows agent-connected message when installed', () => {
    const plain = stripAnsi(renderDemoCompletionSummary(projectDir, true));
    expect(plain).toContain('agent is connected');
  });

  it('includes star headline', () => {
    const plain = stripAnsi(renderDemoCompletionSummary(projectDir, true));
    expect(plain).toContain('★ ktx demo is ready');
  });

  it('shows manual instructions when agent not installed', () => {
    const plain = stripAnsi(renderDemoCompletionSummary(projectDir, false));
    expect(plain).toContain('--agents');
    expect(plain).toContain(`--project-dir ${projectDir}`);
  });
});

describe('buildDemoReplayTimeline', () => {
  const timeline = buildDemoReplayTimeline();
  const connectionIds = new Set(timeline.map((e) => e.connectionId));

  it('produces events for all 4 targets', () => {
    expect(connectionIds.size).toBe(4);
    expect(connectionIds).toContain('postgres-warehouse');
    expect(connectionIds).toContain('dbt-main');
    expect(connectionIds).toContain('metabase-main');
    expect(connectionIds).toContain('notion-main');
  });

  it('all targets end as done', () => {
    for (const id of connectionIds) {
      const events = timeline.filter((e) => e.connectionId === id);
      const last = events[events.length - 1];
      expect(last.status).toBe('done');
    }
  });

  it('events are sorted by delayMs', () => {
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].delayMs).toBeGreaterThanOrEqual(timeline[i - 1].delayMs);
    }
  });

  it('uses schema-context wording for database progress', () => {
    const renderedTimeline = timeline
      .map((event) => [event.detailLine, event.summaryText].filter(Boolean).join(' '))
      .join('\n');

    expect(renderedTimeline).toContain('reading schema');
    expect(renderedTimeline).toContain('56 tables');
    expect(renderedTimeline).not.toContain('scanning');
    expect(renderedTimeline).not.toContain('scanned');
  });
});

describe('DEMO_REPLAY_TARGETS', () => {
  it('has 1 primary source', () => {
    expect(DEMO_REPLAY_TARGETS.primarySources).toHaveLength(1);
  });

  it('has 3 context sources', () => {
    expect(DEMO_REPLAY_TARGETS.contextSources).toHaveLength(3);
  });

  it('primary source is a database-ingest operation', () => {
    expect(DEMO_REPLAY_TARGETS.primarySources[0].operation).toBe('database-ingest');
  });

  it('context sources are source-ingest operations', () => {
    for (const source of DEMO_REPLAY_TARGETS.contextSources) {
      expect(source.operation).toBe('source-ingest');
    }
  });
});

describe('runDemoTour', () => {
  function createMockIo() {
    const chunks: string[] = [];
    return {
      io: {
        stdout: { isTTY: true, columns: 80, write: (chunk: string) => { chunks.push(chunk); } },
        stderr: { write: () => {} },
      },
      chunks,
    };
  }

  it('returns 0 on successful tour with agent installed', async () => {
    const { io, chunks } = createMockIo();
    const mockAgents = vi.fn().mockResolvedValue({
      status: 'ready',
      projectDir: '/tmp/test',
      installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp-cli', installRoot: '/tmp/test' }],
    } satisfies KtxSetupAgentsResult);

    const navigation = vi.fn().mockResolvedValue('forward');

    const result = await runDemoTour(
      { inputMode: 'auto' },
      io,
      {
        agents: mockAgents,
        waitForNavigation: navigation,
        skipReplayAnimation: true,
        ensureProject: vi.fn().mockResolvedValue({ projectDir: '/tmp/test' }),
      },
    );
    expect(result).toBe(0);
    expect(mockAgents).toHaveBeenCalled();
    // Should have rendered completion summary
    const allOutput = chunks.join('');
    expect(allOutput).toContain('agent is connected');
  });

  it('handles back navigation from first step by exiting', async () => {
    const { io } = createMockIo();
    const navigation = vi.fn().mockResolvedValue('back');

    const result = await runDemoTour(
      { inputMode: 'auto' },
      io,
      {
        waitForNavigation: navigation,
        skipReplayAnimation: true,
        ensureProject: vi.fn().mockResolvedValue({ projectDir: '/tmp/test' }),
      },
    );
    expect(result).toBe(0);
    // Navigation called once for intro, then exits on back
    expect(navigation).toHaveBeenCalledTimes(1);
  });

  it('goes back from sources to databases', async () => {
    const { io } = createMockIo();
    let callCount = 0;
    const navigation = vi.fn().mockImplementation(() => {
      callCount++;
      // First call (intro): forward
      // Second call (databases): forward
      // Third call (sources): back
      // Fourth call (databases again): back (exit)
      if (callCount <= 2) return Promise.resolve('forward');
      return Promise.resolve('back');
    });

    const result = await runDemoTour(
      { inputMode: 'auto' },
      io,
      {
        waitForNavigation: navigation,
        skipReplayAnimation: true,
        ensureProject: vi.fn().mockResolvedValue({ projectDir: '/tmp/test' }),
      },
    );
    expect(result).toBe(0);
    expect(navigation).toHaveBeenCalledTimes(4);
  });

  it('handles agent step returning back', async () => {
    const { io } = createMockIo();
    let navCount = 0;
    const navigation = vi.fn().mockImplementation(() => {
      navCount++;
      // Forward through intro, databases, sources, context
      // Then back from context (after agents returns back)
      // Then back from sources, then back from databases (exit)
      if (navCount <= 4) return Promise.resolve('forward');
      return Promise.resolve('back');
    });

    const mockAgents = vi.fn().mockResolvedValue({
      status: 'back',
      projectDir: '/tmp/test',
    } satisfies KtxSetupAgentsResult);

    const result = await runDemoTour(
      { inputMode: 'auto' },
      io,
      {
        agents: mockAgents,
        waitForNavigation: navigation,
        skipReplayAnimation: true,
        ensureProject: vi.fn().mockResolvedValue({ projectDir: '/tmp/test' }),
      },
    );
    expect(result).toBe(0);
  });
});
