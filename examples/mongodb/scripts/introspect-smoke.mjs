// Deterministic, no-LLM smoke for the MongoDB connector. Drives the same
// introspection entry point ktx ingest's "database schema" stage uses, against
// the seeded example database, and asserts the inferred schema.
//
// Usage: node introspect-smoke.mjs [mongoUrl]
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ktxRoot = resolve(here, '../../..');
const connectorUrl = `file://${resolve(
  ktxRoot,
  'packages/cli/dist/connectors/mongodb/live-database-introspection.js',
)}`;

const mongoUrl = process.argv[2] ?? 'mongodb://localhost:27117/app';

const { createMongoDbLiveDatabaseIntrospection } = await import(connectorUrl);

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

const port = createMongoDbLiveDatabaseIntrospection({
  connections: { 'mongo-example': { driver: 'mongodb', url: mongoUrl, databases: ['app'] } },
});

const snapshot = await port.extractSchema('mongo-example');
const tables = new Map(snapshot.tables.map((table) => [table.name, table]));

assert(snapshot.driver === 'mongodb', 'snapshot driver is mongodb');
assert(['orders', 'users'].every((name) => tables.has(name)), 'users and orders collections introspected');

const users = tables.get('users');
const columns = new Map(users.columns.map((column) => [column.name, column]));
assert(columns.get('_id')?.primaryKey === true && columns.get('_id')?.nullable === false, '_id is the non-null primary key');
assert(columns.get('age')?.nullable === true, 'age is nullable (absent in one document)');
assert(columns.get('email')?.nullable === false, 'email is non-nullable (present in every document)');
assert(columns.get('address')?.normalizedType === 'json', 'nested address maps to opaque json');
assert(columns.get('tags')?.normalizedType === 'json', 'array tags maps to opaque json');
assert(columns.get('ref')?.nativeType === 'mixed', 'ref with two types is inferred as mixed');

const view = tables.get('active_users');
assert(view?.kind === 'view', 'active_users is a view');
assert(view?.estimatedRows === null, 'a view is introspected without a count (estimatedRows null)');

console.log(`OK: introspected ${snapshot.tables.length} collections from ${mongoUrl}`);
for (const table of snapshot.tables) {
  console.log(`  - ${table.db}.${table.name} (${table.kind}, ${table.columns.length} columns)`);
}
process.exit(0);
