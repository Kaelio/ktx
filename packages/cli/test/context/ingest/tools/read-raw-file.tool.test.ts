import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadRawFileTool } from '../../../../src/context/ingest/tools/read-raw-file.tool.js';

describe('read_raw_file tool', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'readraw-'));
    await mkdir(join(stagedDir, 'views'), { recursive: true });
    await writeFile(join(stagedDir, 'views', 'a.yml'), 'line1\nline2\nline3\n', 'utf-8');
    await writeFile(join(stagedDir, 'peer.yml'), 'secret', 'utf-8');
  });

  afterEach(async () => rm(stagedDir, { recursive: true, force: true }));

  it('returns content for an allowed path', async () => {
    const tool = createReadRawFileTool({ stagedDir, allowedPaths: new Set(['views/a.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'views/a.yml' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });

  it('accepts forward-slash allow-list paths on Windows-style path normalization', async () => {
    const tool = createReadRawFileTool({ stagedDir, allowedPaths: new Set(['views/a.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'views\\a.yml' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toContain('line1');
  });

  it('refuses to return oversized files and directs callers to read spans', async () => {
    await writeFile(join(stagedDir, 'views', 'huge.yml'), `${'x'.repeat(160_000)}\n`, 'utf-8');
    const tool = createReadRawFileTool({ stagedDir, allowedPaths: new Set(['views/huge.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'views/huge.yml' },
      { toolCallId: 't1', messages: [] },
    );

    expect(result).toMatch(/too large/i);
    expect(result).toMatch(/read_raw_span/i);
    expect(String(result).length).toBeLessThan(1000);
  });

  it('rejects a path not in the allow-list', async () => {
    const tool = createReadRawFileTool({ stagedDir, allowedPaths: new Set(['views/a.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'peer.yml' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toMatch(/not accessible/i);
    expect(result).not.toContain('secret');
  });

  it('rejects directory traversal attempts', async () => {
    const tool = createReadRawFileTool({ stagedDir, allowedPaths: new Set(['views/a.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: '../outside.yml' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toMatch(/not accessible/i);
  });

  it('returns a clear error when the file is missing despite being allowed', async () => {
    const tool = createReadRawFileTool({ stagedDir, allowedPaths: new Set(['views/missing.yml']) });
    const result = await (tool.execute as (...args: unknown[]) => unknown)(
      { path: 'views/missing.yml' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toMatch(/not found/i);
  });
});
