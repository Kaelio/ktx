import type { KtxCliIo } from '../cli-runtime.js';
import type { KtxOutputMode } from './mode.js';

export interface KtxResultTable {
  connectionId: string;
  headers: string[];
  headerTypes?: string[];
  rows: unknown[][];
  rowCount: number;
}

/** @internal */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

function printJson(output: KtxResultTable, io: KtxCliIo): void {
  io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function printPlain(output: KtxResultTable, io: KtxCliIo): void {
  io.stdout.write(`${output.headers.join('\t')}\n`);
  for (const row of output.rows) {
    io.stdout.write(`${row.map(formatValue).join('\t')}\n`);
  }
}

function printPretty(output: KtxResultTable, io: KtxCliIo): void {
  const rows = output.rows.map((row) => row.map(formatValue));
  const widths = output.headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join('  ').trimEnd();

  if (output.headers.length > 0) {
    io.stdout.write(`${renderRow(output.headers)}\n`);
    io.stdout.write(`${renderRow(widths.map((width) => '-'.repeat(width)))}\n`);
  }
  for (const row of rows) {
    io.stdout.write(`${renderRow(row)}\n`);
  }
  io.stdout.write(`\n${output.rowCount} ${output.rowCount === 1 ? 'row' : 'rows'}\n`);
}

export function printResultTable(output: KtxResultTable, mode: KtxOutputMode, io: KtxCliIo): void {
  if (mode === 'json') {
    printJson(output, io);
    return;
  }
  if (mode === 'plain') {
    printPlain(output, io);
    return;
  }
  printPretty(output, io);
}
