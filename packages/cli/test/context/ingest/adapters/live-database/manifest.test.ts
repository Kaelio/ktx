import { describe, expect, it } from 'vitest';
import {
  buildLiveDatabaseManifestShards,
  type LiveDatabaseManifestExistingDescriptions,
  type LiveDatabaseManifestJoinEntry,
  type LiveDatabaseManifestShard,
} from '../../../../../src/context/ingest/adapters/live-database/manifest.js';

function shardObject(shards: Map<string, LiveDatabaseManifestShard>): Record<string, LiveDatabaseManifestShard> {
  return Object.fromEntries([...shards.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

describe('buildLiveDatabaseManifestShards', () => {
  it('builds shard objects with generated joins and preserved external descriptions', () => {
    const existingDescriptions = new Map<string, LiveDatabaseManifestExistingDescriptions>([
      [
        'public.orders',
        {
          table: { user: 'Pinned analyst description', db: 'Old db description' },
          columns: new Map([['id', { user: 'Pinned id description', db: 'Old id description' }]]),
        },
      ],
    ]);

    const preservedJoins = new Map<string, LiveDatabaseManifestJoinEntry[]>([
      [
        'orders',
        [
          {
            to: 'customers',
            on: 'orders.account_id = customers.id',
            relationship: 'many_to_one',
            source: 'manual',
          },
          {
            to: 'missing_accounts',
            on: 'orders.account_id = missing_accounts.id',
            relationship: 'many_to_one',
            source: 'manual',
          },
        ],
      ],
    ]);

    const result = buildLiveDatabaseManifestShards({
      connectionType: 'POSTGRESQL',
      mapColumnType: (nativeType) => nativeType.toLowerCase(),
      existingDescriptions,
      existingPreservedJoins: preservedJoins,
      tables: [
        {
          name: 'orders',
          catalog: null,
          db: 'public',
          descriptions: { db: 'Fresh db description', ai: 'Generated AI description' },
          columns: [
            {
              name: 'id',
              type: 'INTEGER',
              pk: true,
              nullable: false,
              descriptions: { db: 'Fresh id description' },
            },
            {
              name: 'customer_id',
              type: 'INTEGER',
            },
          ],
        },
        {
          name: 'customers',
          catalog: null,
          db: 'public',
          columns: [
            {
              name: 'id',
              type: 'INTEGER',
              pk: true,
              nullable: false,
            },
          ],
        },
      ],
      joins: [
        {
          fromTable: 'orders',
          fromColumns: ['customer_id'],
          toTable: 'customers',
          toColumns: ['id'],
          relationship: 'MANY_TO_ONE',
          source: 'formal',
        },
      ],
    });

    expect(result.tablesProcessed).toBe(2);
    expect(shardObject(result.shards)).toEqual({
      public: {
        tables: {
          orders: {
            table: 'public.orders',
            descriptions: {
              user: 'Pinned analyst description',
              db: 'Fresh db description',
              ai: 'Generated AI description',
            },
            columns: [
              {
                name: 'id',
                type: 'integer',
                pk: true,
                nullable: false,
                descriptions: {
                  user: 'Pinned id description',
                  db: 'Fresh id description',
                },
              },
              {
                name: 'customer_id',
                type: 'integer',
              },
            ],
            joins: [
              {
                to: 'customers',
                on: 'orders.customer_id = customers.id',
                relationship: 'many_to_one',
                source: 'formal',
              },
              {
                to: 'customers',
                on: 'orders.account_id = customers.id',
                relationship: 'many_to_one',
                source: 'manual',
              },
            ],
          },
          customers: {
            table: 'public.customers',
            columns: [
              {
                name: 'id',
                type: 'integer',
                pk: true,
                nullable: false,
              },
            ],
            joins: [
              {
                to: 'orders',
                on: 'customers.id = orders.customer_id',
                relationship: 'one_to_many',
                source: 'formal',
              },
            ],
          },
        },
      },
    });
  });

  it('uses warehouse and schema shard keys for snowflake-style connections', () => {
    const result = buildLiveDatabaseManifestShards({
      connectionType: 'SNOWFLAKE',
      mapColumnType: (nativeType) => nativeType.toLowerCase(),
      tables: [
        {
          name: 'accounts',
          catalog: 'ANALYTICS',
          db: 'CORE',
          columns: [{ name: 'id', type: 'NUMBER' }],
        },
      ],
      joins: [],
    });

    expect(shardObject(result.shards)).toEqual({
      'ANALYTICS.CORE': {
        tables: {
          accounts: {
            table: 'ANALYTICS.CORE.accounts',
            columns: [{ name: 'id', type: 'number' }],
          },
        },
      },
    });
  });

  it('preserves external usage keys while replacing historic SQL managed keys', () => {
    const existingUsage = new Map([
      [
        'public.orders',
        {
          narrative: 'Old generated usage narrative.',
          frequencyTier: 'low' as const,
          commonFilters: ['old_status'],
          commonJoins: [],
          ownerNote: 'Pinned analyst note',
        },
      ],
    ]);

    const result = buildLiveDatabaseManifestShards({
      connectionType: 'POSTGRESQL',
      mapColumnType: (nativeType) => nativeType.toLowerCase(),
      existingUsage,
      tables: [
        {
          name: 'orders',
          catalog: null,
          db: 'public',
          usage: {
            narrative: 'Fresh generated usage narrative.',
            frequencyTier: 'high',
            commonFilters: ['status'],
            commonGroupBys: ['created_at'],
            commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
          },
          columns: [{ name: 'id', type: 'INTEGER' }],
        },
      ],
      joins: [],
    });

    expect(shardObject(result.shards)).toEqual({
      public: {
        tables: {
          orders: {
            table: 'public.orders',
            usage: {
              ownerNote: 'Pinned analyst note',
              narrative: 'Fresh generated usage narrative.',
              frequencyTier: 'high',
              commonFilters: ['status'],
              commonGroupBys: ['created_at'],
              commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
            },
            columns: [{ name: 'id', type: 'integer' }],
          },
        },
      },
    });
  });

  it('renders ordered multi-column joins in both directions', () => {
    const result = buildLiveDatabaseManifestShards({
      connectionType: 'POSTGRESQL',
      mapColumnType: (nativeType) => nativeType,
      tables: [
        {
          name: 'order_lines',
          catalog: null,
          db: 'public',
          columns: [
            { name: 'order_id', type: 'integer' },
            { name: 'line_number', type: 'integer' },
          ],
        },
        {
          name: 'order_line_allocations',
          catalog: null,
          db: 'public',
          columns: [
            { name: 'order_id', type: 'integer' },
            { name: 'line_number', type: 'integer' },
          ],
        },
      ],
      joins: [
        {
          fromTable: 'order_line_allocations',
          fromColumns: ['order_id', 'line_number'],
          toTable: 'order_lines',
          toColumns: ['order_id', 'line_number'],
          relationship: 'many_to_one',
          source: 'inferred',
        },
      ],
    });

    expect(shardObject(result.shards)).toMatchObject({
      public: {
        tables: {
          order_line_allocations: {
            joins: [
              {
                to: 'order_lines',
                on: 'order_line_allocations.order_id = order_lines.order_id AND order_line_allocations.line_number = order_lines.line_number',
                relationship: 'many_to_one',
                source: 'inferred',
              },
            ],
          },
          order_lines: {
            joins: [
              {
                to: 'order_line_allocations',
                on: 'order_lines.order_id = order_line_allocations.order_id AND order_lines.line_number = order_line_allocations.line_number',
                relationship: 'one_to_many',
                source: 'inferred',
              },
            ],
          },
        },
      },
    });
  });
});
