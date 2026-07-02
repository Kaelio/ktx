import { Command } from '@commander-js/extra-typings';
import { describe, expect, it, vi } from 'vitest';
import type { KtxCliCommandContext } from '../../src/cli-program.js';
import { parseEnrichmentStagesOption, registerIngestCommands } from '../../src/commands/ingest-commands.js';

function makeContext(overrides: Partial<KtxCliCommandContext> = {}): KtxCliCommandContext {
  let exitCode = 0;
  return {
    io: {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    },
    deps: {},
    packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
    setExitCode: (code: number) => {
      exitCode = code;
    },
    runInit: vi.fn(),
    writeDebug: vi.fn(),
    ...overrides,
    get exitCode() {
      return exitCode;
    },
  } as unknown as KtxCliCommandContext;
}

function ingestProgram(context: KtxCliCommandContext): Command {
  const program = new Command().exitOverride().option('--project-dir <path>');
  registerIngestCommands(program, context, { runTextIngest: vi.fn(async () => 0) });
  return program;
}

describe('parseEnrichmentStagesOption', () => {
  it('parses a single stage', () => {
    expect(parseEnrichmentStagesOption('relationships')).toEqual(['relationships']);
  });

  it('orders and de-duplicates by the canonical registry order', () => {
    expect(parseEnrichmentStagesOption('embeddings,descriptions')).toEqual(['descriptions', 'embeddings']);
    expect(parseEnrichmentStagesOption('relationships,relationships,descriptions')).toEqual([
      'descriptions',
      'relationships',
    ]);
  });

  it('tolerates surrounding whitespace and empty segments', () => {
    expect(parseEnrichmentStagesOption(' descriptions , , embeddings ')).toEqual(['descriptions', 'embeddings']);
  });

  it('rejects an empty list', () => {
    expect(() => parseEnrichmentStagesOption('')).toThrow(/non-empty/);
    expect(() => parseEnrichmentStagesOption(' , ')).toThrow(/non-empty/);
  });

  it('rejects an unknown stage name', () => {
    expect(() => parseEnrichmentStagesOption('foo')).toThrow(/unknown stage "foo"/);
    expect(() => parseEnrichmentStagesOption('descriptions,foo')).toThrow(/unknown stage "foo"/);
  });
});

describe('ktx ingest --stages', () => {
  it('threads a parsed stage set into the public ingest args', async () => {
    const publicIngest = vi.fn(async (_args: unknown) => 0);
    const context = makeContext({ deps: { publicIngest } });
    const program = ingestProgram(context);

    await program.parseAsync(
      ['--project-dir', '/tmp/ktx', 'ingest', 'warehouse', '--stages', 'descriptions,embeddings'],
      { from: 'user' },
    );

    expect(publicIngest).toHaveBeenCalledTimes(1);
    expect(publicIngest.mock.calls[0]?.[0]).toMatchObject({
      command: 'run',
      targetConnectionId: 'warehouse',
      stages: ['descriptions', 'embeddings'],
    });
  });

  it('omits stages entirely when the flag is absent (default = all)', async () => {
    const publicIngest = vi.fn(async (_args: unknown) => 0);
    const context = makeContext({ deps: { publicIngest } });
    const program = ingestProgram(context);

    await program.parseAsync(['--project-dir', '/tmp/ktx', 'ingest', 'warehouse'], { from: 'user' });

    expect(publicIngest).toHaveBeenCalledTimes(1);
    expect(publicIngest.mock.calls[0]?.[0]).not.toHaveProperty('stages');
  });

  it('rejects an unknown stage with a clear parse error', async () => {
    const publicIngest = vi.fn(async (_args: unknown) => 0);
    const context = makeContext({ deps: { publicIngest } });
    const program = ingestProgram(context);

    await expect(
      program.parseAsync(['--project-dir', '/tmp/ktx', 'ingest', 'warehouse', '--stages', 'foo'], { from: 'user' }),
    ).rejects.toThrow(/unknown stage "foo"/);
    expect(publicIngest).not.toHaveBeenCalled();
  });

  it('rejects --stages combined with text capture', async () => {
    const publicIngest = vi.fn(async (_args: unknown) => 0);
    const runTextIngest = vi.fn(async () => 0);
    const context = makeContext({ deps: { publicIngest } });
    const program = new Command().exitOverride().option('--project-dir <path>');
    registerIngestCommands(program, context, { runTextIngest });

    await expect(
      program.parseAsync(['--project-dir', '/tmp/ktx', 'ingest', '--text', 'hi', '--stages', 'descriptions'], {
        from: 'user',
      }),
    ).rejects.toThrow(/--stages applies to database ingest only/);
    expect(publicIngest).not.toHaveBeenCalled();
    expect(runTextIngest).not.toHaveBeenCalled();
  });
});
