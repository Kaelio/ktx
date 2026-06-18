import { describe, expect, it } from 'vitest';
import { buildJoinsByTable, buildLiveDatabaseManifestShards } from '../../../src/context/ingest/adapters/live-database/manifest.js';

const joinData = (toTable: string) => ({
  fromTable: 'books',
  fromColumns: ['id'],
  toTable,
  toColumns: ['book_id'],
  relationship: 'one_to_many',
  source: 'manual' as const,
});

describe('buildJoinsByTable federated siblings', () => {
  it('keeps a forward join whose target is a federated sibling table', () => {
    const result = buildJoinsByTable(
      new Set(['books']), // current snapshot
      [joinData('sqlite_reviews.reviews')], // target NOT local
      new Map(),
      new Set(['sqlite_reviews.reviews']), // federated sibling targets
    );
    expect(result.get('books')?.map((j) => j.to)).toEqual(['sqlite_reviews.reviews']);
    // The sibling target must NOT get a reverse entry (it has no shard in this snapshot)
    expect(result.get('sqlite_reviews.reviews')).toBeUndefined();
  });

  it('still drops a join whose target is neither local nor a sibling', () => {
    const result = buildJoinsByTable(new Set(['books']), [joinData('ghost')], new Map(), new Set());
    expect(result.get('books')).toBeUndefined();
  });

  it('keeps both directions for a fully-local join (unchanged behavior)', () => {
    const result = buildJoinsByTable(new Set(['books', 'authors']), [joinData('authors')], new Map(), new Set());
    expect(result.get('books')?.map((j) => j.to)).toEqual(['authors']);
    expect(result.get('authors')?.map((j) => j.to)).toEqual(['books']); // reverse still added for local joins
  });
});

describe('buildLiveDatabaseManifestShards federated preserved joins', () => {
  it('keeps a preserved manual join whose target is a federated sibling', () => {
    const result = buildLiveDatabaseManifestShards({
      connectionType: 'POSTGRES',
      tables: [{ name: 'books', catalog: null, db: 'public', columns: [{ name: 'id', type: 'int' }] }],
      joins: [],
      existingPreservedJoins: new Map([
        [
          'books',
          [{ to: 'sqlite_reviews.reviews', on: 'books.id = reviews.book_id', relationship: 'one_to_many', source: 'manual' }],
        ],
      ]),
      federatedSiblingTargets: new Set(['sqlite_reviews.reviews']),
      mapColumnType: (t) => t,
    });
    const shard = result.shards.get('public');
    expect(shard?.tables.books?.joins?.map((j) => j.to)).toEqual(['sqlite_reviews.reviews']);
  });

  it('still drops a preserved join whose target is neither local nor a sibling', () => {
    const result = buildLiveDatabaseManifestShards({
      connectionType: 'POSTGRES',
      tables: [{ name: 'books', catalog: null, db: 'public', columns: [{ name: 'id', type: 'int' }] }],
      joins: [],
      existingPreservedJoins: new Map([
        ['books', [{ to: 'ghost', on: 'books.id = ghost.id', relationship: 'one_to_many', source: 'manual' }]],
      ]),
      federatedSiblingTargets: new Set(),
      mapColumnType: (t) => t,
    });
    expect(result.shards.get('public')?.tables.books?.joins).toBeUndefined();
  });
});
