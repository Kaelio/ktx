import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';

interface ReadRawFileDeps {
  stagedDir: string;
  allowedPaths: Set<string>;
}

const MAX_READ_RAW_FILE_BYTES = 120_000;

function normalizeRawPath(path: string): string {
  return normalize(path).replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

export function createReadRawFileTool(deps: ReadRawFileDeps) {
  const stagedRoot = resolve(deps.stagedDir);
  const allowedPaths = new Set([...deps.allowedPaths].map(normalizeRawPath));
  return tool({
    description:
      "Read the full text content of a raw source file inside this WorkUnit. `path` must be relative to the staged bundle root (no leading slash, no `..`) and must appear in the WorkUnit's rawFiles or dependencyPaths list.",
    inputSchema: z.object({
      path: z.string().describe('Path relative to the staged bundle root. Example: "views/customers/customer.lkml".'),
    }),
    execute: async ({ path }) => {
      const normalized = normalizeRawPath(path);
      if (normalized.startsWith('..') || !allowedPaths.has(normalized)) {
        return `Error: path "${path}" is not accessible from this WorkUnit. Allowed paths: ${[...allowedPaths].sort().join(', ')}`;
      }
      const absolute = resolve(join(stagedRoot, normalized));
      const stagedRelative = relative(stagedRoot, absolute);
      if (stagedRelative.startsWith('..') || isAbsolute(stagedRelative)) {
        return `Error: path "${path}" is not accessible from this WorkUnit.`;
      }
      try {
        const fileStat = await stat(absolute);
        if (fileStat.size > MAX_READ_RAW_FILE_BYTES) {
          return `Error: file "${path}" is too large to return in full (${fileStat.size} bytes). Use read_raw_span with targeted line ranges instead.`;
        }
        return await readFile(absolute, 'utf-8');
      } catch (err) {
        return `Error: file "${path}" not found. (${err instanceof Error ? err.message : String(err)})`;
      }
    },
  });
}
