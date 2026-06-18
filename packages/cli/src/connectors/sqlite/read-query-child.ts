import Database from 'better-sqlite3';

// Runs on a forked child process (no bundler, no test transform), so it imports
// only better-sqlite3 and node builtins. The SQL is already read-only-validated
// and row-limited by the parent; this process just executes it and posts the
// structured-cloneable raw rows back over IPC. Its only cancellation mechanism
// is the parent sending SIGKILL: a synchronous better-sqlite3 scan never yields,
// so neither a worker-thread terminate nor any in-process timer can interrupt
// it — only the OS reclaiming the whole process can.

interface ReadQueryRequest {
  dbPath: string;
  sql: string;
  params?: Record<string, unknown> | unknown[];
}

type ReadQueryResponse =
  | { ok: true; headers: string[]; rows: unknown[]; totalRows: number }
  | { ok: false; message: string };

process.once('message', (request: ReadQueryRequest) => {
  let db: Database.Database | undefined;
  let response: ReadQueryResponse;
  try {
    db = new Database(request.dbPath, { readonly: true, fileMustExist: true });
    const statement = db.prepare(request.sql);
    const rows = (request.params ? statement.all(request.params) : statement.all()) as unknown[];
    response = {
      ok: true,
      headers: statement.columns().map((column) => column.name),
      rows,
      totalRows: rows.length,
    };
  } catch (error) {
    response = { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
  process.send?.(response, () => process.exit(0));
});
