import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadRawSpanTool } from '../../../../src/context/ingest/tools/read-raw-span.tool.js';

describe('read_raw_span tool', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'readspan-'));
    await mkdir(join(stagedDir, 'v'), { recursive: true });
    await writeFile(join(stagedDir, 'v', 'a.yml'), 'line1\nline2\nline3\nline4\nline5\n', 'utf-8');
  });

  afterEach(async () => rm(stagedDir, { recursive: true, force: true }));

  it('returns the requested 1-based inclusive line range', async () => {
    const tool = createReadRawSpanTool({ stagedDir, allowedPaths: new Set(['v/a.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'v/a.yml', startLine: 2, endLine: 4 },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toBe('line2\nline3\nline4');
  });

  it('accepts forward-slash allow-list paths on Windows-style path normalization', async () => {
    const tool = createReadRawSpanTool({ stagedDir, allowedPaths: new Set(['v/a.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'v\\a.yml', startLine: 2, endLine: 3 },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toBe('line2\nline3');
  });

  it('clamps endLine to the end of the file', async () => {
    const tool = createReadRawSpanTool({ stagedDir, allowedPaths: new Set(['v/a.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'v/a.yml', startLine: 4, endLine: 99 },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toBe('line4\nline5');
  });

  it('rejects start > end', async () => {
    const tool = createReadRawSpanTool({ stagedDir, allowedPaths: new Set(['v/a.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'v/a.yml', startLine: 5, endLine: 2 },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toMatch(/startLine must be/i);
  });

  it('rejects paths not in the allow-list', async () => {
    const tool = createReadRawSpanTool({ stagedDir, allowedPaths: new Set([]) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'v/a.yml', startLine: 1, endLine: 1 },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toMatch(/not accessible/i);
  });
});
