import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('TableauClient boundary', () => {
  it('does not import server, NestJS, or ingest-internal modules', async () => {
    const source = await readFile(
      new URL('../../../../../src/context/ingest/adapters/tableau/client.ts', import.meta.url),
      'utf-8',
    );

    expect(source).not.toMatch(/@nestjs\/common/);
    expect(source).not.toMatch(/DataSourceClient/);
    expect(source).not.toMatch(/\.\.\/interfaces/);
    // The client must only depend on its own adapter folder (client-port / types),
    // never on the shared ingest types or anything above the adapter directory.
    expect(source).not.toMatch(/from '\.\.\//);
    expect(source).not.toMatch(/server\/src/);
  });
});
