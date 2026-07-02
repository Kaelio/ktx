import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';

interface ReadRawSpanDeps {
  stagedDir: string;
  allowedPaths: Set<string>;
}

function normalizeRawPath(path: string): string {
  return normalize(path).replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

export function createReadRawSpanTool(deps: ReadRawSpanDeps) {
  const stagedRoot = resolve(deps.stagedDir);
  const allowedPaths = new Set([...deps.allowedPaths].map(normalizeRawPath));
  return tool({
    description:
      'Read a 1-based inclusive line range from a raw source file. Use this to resolve a provenance pointer like `file.lkml#L15-28` without loading the whole file into context.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to the staged bundle root.'),
      startLine: z.number().int().min(1).describe('First line to return (1-based, inclusive).'),
      endLine: z.number().int().min(1).describe('Last line to return (1-based, inclusive). Clamped to file length.'),
    }),
    execute: async ({ path, startLine, endLine }) => {
      if (startLine > endLine) {
        return `Error: startLine must be <= endLine (got startLine=${startLine}, endLine=${endLine})`;
      }
      const normalized = normalizeRawPath(path);
      if (normalized.startsWith('..') || !allowedPaths.has(normalized)) {
        return `Error: path "${path}" is not accessible from this context. Allowed paths: ${[...allowedPaths].sort().join(', ')}`;
      }
      const absolute = resolve(join(stagedRoot, normalized));
      const stagedRelative = relative(stagedRoot, absolute);
      if (stagedRelative.startsWith('..') || isAbsolute(stagedRelative)) {
        return `Error: path "${path}" is not accessible from this context.`;
      }
      try {
        const body = await readFile(absolute, 'utf-8');
        const rawLines = body.split('\n');
        // Treat a trailing empty element caused by a file-ending newline as NOT a line.
        const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
        const from = Math.max(1, startLine);
        const to = Math.min(lines.length, endLine);
        return lines.slice(from - 1, to).join('\n');
      } catch (err) {
        return `Error: file "${path}" not found. (${err instanceof Error ? err.message : String(err)})`;
      }
    },
  });
}
