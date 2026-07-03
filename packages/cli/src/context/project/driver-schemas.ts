import * as z from 'zod';
import {
  lookerMappingsSchema,
  lookmlMappingsSchema,
  metabaseMappingsSchema,
} from './mappings-yaml-schema.js';

const warehouseDrivers = [
  'postgres',
  'mysql',
  'snowflake',
  'bigquery',
  'sqlite',
  'duckdb',
  'clickhouse',
  'sqlserver',
  'athena',
] as const;

type WarehouseDriver = (typeof warehouseDrivers)[number];

function warehouseConnectionSchema<const Driver extends WarehouseDriver>(driver: Driver) {
  return z
    .looseObject({
      driver: z.literal(driver),
      url: z
        .string()
        .min(1)
        .optional()
        .describe('Warehouse connection URL or DSN; may contain environment-variable references like env:DATABASE_URL.'),
      enabled_tables: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Optional allowlist of object names to ingest. Accepted forms: "catalog.db.name", "db.name" (schema-qualified), or bare "name". When set, live-database ingest restricts the scan to the listed objects and fails with a clear error if none match. For SQLite, "main.<name>" and the bare "<name>" are equivalent (SQLite exposes a single "main" schema). Useful for smoke-testing ingest on a single table.',
        ),
      query_timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Maximum execution time for a single read-only query, in milliseconds (default 30000). Enforced as a server-side statement timeout for remote engines and by SIGKILL-ing a forked query subprocess for in-process SQLite. A query exceeding it is cancelled and returns a "query exceeded Ns" error so the agent can revise.',
        ),
      query_policy: z
        .enum(['read-only-sql', 'semantic-layer-only'])
        .optional()
        .describe(
          'Agent-facing query authorship policy (default "read-only-sql"). "read-only-sql" allows parser-validated read-only SQL plus semantic-layer queries. "semantic-layer-only" rejects raw SQL on this connection (`ktx sql`, the sql_execution tool, and federated queries that include it) and restricts semantic-layer queries to measures predefined in the semantic-layer sources. ktx-internal scan and ingest queries are unaffected.',
        ),
    })
    .describe(
      `${driver} warehouse connection. Additional driver-tunable fields (e.g. context.queryHistory) are accepted and passed through.`,
    );
}

const warehouseConnectionSchemas = [
  warehouseConnectionSchema('postgres'),
  warehouseConnectionSchema('mysql'),
  warehouseConnectionSchema('snowflake'),
  warehouseConnectionSchema('bigquery'),
  warehouseConnectionSchema('sqlite'),
  warehouseConnectionSchema('duckdb'),
  warehouseConnectionSchema('clickhouse'),
  warehouseConnectionSchema('sqlserver'),
  warehouseConnectionSchema('athena'),
] as const;

const mongodbConnectionSchema = z
  .looseObject({
    driver: z.literal('mongodb'),
    url: z
      .string()
      .min(1)
      .describe(
        'MongoDB connection string (mongodb:// or mongodb+srv://, including TLS/Atlas); may contain a reference like env:MONGO_URL.',
      ),
    database: z.string().min(1).optional().describe('Single database to introspect when not using databases or a URL path.'),
    databases: z
      .array(z.string().min(1))
      .optional()
      .describe('Databases whose collections ktx introspects as tables. Falls back to the URL path database.'),
    enabled_tables: z
      .array(z.string().min(1))
      .optional()
      .describe('Optional allowlist of "database.collection" names to introspect.'),
    sample_size: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('How many recent documents to sample per collection when inferring the schema (default 1000).'),
    order_by: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Field to sort by descending when sampling. Defaults to _id; set this when _id is not an ObjectId. ' +
          'Should be indexed — an unindexed sort hits MongoDB\'s in-memory sort limit on large collections.',
      ),
  })
  .describe('MongoDB primary-source connection. Schema is inferred by sampling the most recent documents.');

const positiveIntKeyMessage = (field: string) => `${field} keys must be positive-integer strings (e.g. "1", "42")`;

const positiveIntKeyRegex = /^[1-9]\d*$/;

const metabaseMappingsStrictSchema = metabaseMappingsSchema.superRefine((value, ctx) => {
  for (const key of Object.keys(value.databaseMappings ?? {})) {
    if (!positiveIntKeyRegex.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['databaseMappings', key],
        message: positiveIntKeyMessage('databaseMappings'),
      });
    }
  }
  for (const key of Object.keys(value.syncEnabled ?? {})) {
    if (!positiveIntKeyRegex.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['syncEnabled', key],
        message: positiveIntKeyMessage('syncEnabled'),
      });
    }
  }
});

const metabaseConnectionSchema = z
  .looseObject({
    driver: z.literal('metabase'),
    api_url: z.string().url().describe('Metabase instance API URL (e.g. https://metabase.example.com).'),
    api_key: z.string().min(1).optional().describe('Literal Metabase API key. Prefer api_key_ref for safety.'),
    api_key_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to Metabase API key (e.g. env:METABASE_API_KEY or file:/path).'),
    network_proxy: z.looseObject({}).optional().describe('Optional network proxy configuration (snake_case form).'),
    networkProxy: z.looseObject({}).optional().describe('Optional network proxy configuration (camelCase form).'),
    mappings: metabaseMappingsStrictSchema
      .optional()
      .describe('Metabase database-to-warehouse mappings and sync configuration.'),
  })
  .describe('Metabase context-source connection.');

const lookerConnectionSchema = z
  .looseObject({
    driver: z.literal('looker'),
    base_url: z.string().url().describe('Looker instance base URL (e.g. https://looker.example.com).'),
    client_id: z.string().min(1).describe('Looker OAuth client ID.'),
    client_secret: z.string().min(1).optional().describe('Literal Looker OAuth client secret. Prefer client_secret_ref.'),
    client_secret_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to Looker OAuth client secret (e.g. env:LOOKER_CLIENT_SECRET).'),
    mappings: lookerMappingsSchema.optional().describe('Looker connection-name to ktx warehouse mappings.'),
  })
  .describe('Looker context-source connection.');

const lookmlConnectionSchema = z
  .looseObject({
    driver: z.literal('lookml'),
    repoUrl: z
      .string()
      .min(1)
      .describe('Git URL of the LookML project (https, ssh, or file:). Field is camelCase by convention.'),
    branch: z.string().min(1).optional().describe('Git branch (default "main" downstream).'),
    path: z.string().optional().describe('Subdirectory within the repo when the LookML project lives in a monorepo.'),
    auth_token_ref: z.string().min(1).optional().describe('Reference to Git auth token for private repos (e.g. env:GITHUB_TOKEN).'),
    mappings: lookmlMappingsSchema.optional().describe('LookML expected-connection mapping for ingest gating.'),
  })
  .describe('LookML context-source connection.');

const notionConnectionSchema = z
  .looseObject({
    driver: z.literal('notion'),
    auth_token: z.string().min(1).optional().describe('Literal Notion integration token. Prefer auth_token_ref.'),
    auth_token_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to Notion integration token (e.g. env:NOTION_TOKEN).'),
    crawl_mode: z
      .enum(['selected_roots', 'all_accessible'])
      .optional()
      .describe(
        'Crawl scope. "selected_roots" requires at least one of root_page_ids, root_database_ids, root_data_source_ids.',
      ),
    root_page_ids: z.array(z.string().min(1)).optional().describe('Notion page IDs to crawl when crawl_mode is selected_roots.'),
    root_database_ids: z
      .array(z.string().min(1))
      .optional()
      .describe('Notion database IDs to crawl when crawl_mode is selected_roots.'),
    root_data_source_ids: z
      .array(z.string().min(1))
      .optional()
      .describe('Notion data source IDs to crawl when crawl_mode is selected_roots.'),
    max_pages_per_run: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe('Maximum Notion pages fetched in a single ingest run.'),
    max_knowledge_creates_per_run: z
      .number()
      .int()
      .min(0)
      .max(25)
      .optional()
      .describe('Maximum new wiki pages created per run.'),
    max_knowledge_updates_per_run: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Maximum existing wiki pages updated per run.'),
  })
  .describe('Notion context-source connection.');

const gdriveConnectionSchema = z
  .looseObject({
    driver: z.literal('gdrive'),
    service_account_key_ref: z
      .string()
      .min(1)
      .describe('Reference to a Google service-account JSON key file. Must use file:/absolute/path/to/key.json.'),
    folder_id: z.string().min(1).describe('Google Drive folder ID to ingest.'),
    recursive: z.boolean().optional().describe('When true, recursively traverse subfolders beneath folder_id.'),
  })
  .describe('Google Drive Google Docs context-source connection.');

const dbtConnectionSchema = z
  .looseObject({
    driver: z.literal('dbt'),
    source_dir: z.string().min(1).optional().describe('Absolute or project-relative path to a local dbt project.'),
    repo_url: z.string().min(1).optional().describe('Git URL of the dbt project (https, ssh, or file:).'),
    branch: z.string().min(1).optional().describe('Git branch when using repo_url.'),
    path: z.string().optional().describe('Subdirectory within the repo when the dbt project lives in a monorepo.'),
    auth_token_ref: z.string().min(1).optional().describe('Reference to Git auth token for private repos.'),
    profiles_path: z.string().optional().describe('Override path to dbt profiles.yml.'),
    target: z.string().min(1).optional().describe('dbt target name (e.g. dev, prod).'),
    project_name: z.string().min(1).optional().describe('Override auto-detected dbt project name.'),
  })
  .describe('dbt context-source connection.');

const metricflowConnectionSchema = z
  .looseObject({
    driver: z.literal('metricflow'),
    metricflow: z
      .looseObject({
        repoUrl: z.string().min(1).describe('Git URL of the MetricFlow / SL project.'),
        branch: z.string().min(1).optional().describe('Git branch (default "main").'),
        path: z.string().optional().describe('Subdirectory within the repo when the SL config lives in a monorepo.'),
        auth_token_ref: z.string().min(1).optional().describe('Reference to Git auth token for private repos.'),
      })
      .describe('Nested MetricFlow configuration block.'),
  })
  .describe('MetricFlow / SL context-source connection.');

const sigmaConnectionSchema = z
  .looseObject({
    driver: z.literal('sigma'),
    api_url: z
      .string()
      .url()
      .default('https://api.sigmacomputing.com')
      .describe('Sigma API base URL. Defaults to the GCP US endpoint; change for other regions.'),
    client_id: z.string().min(1).describe('Sigma API client ID.'),
    client_secret: z.string().min(1).optional().describe('Literal Sigma client secret. Prefer client_secret_ref.'),
    client_secret_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to Sigma client secret (e.g. env:SIGMA_CLIENT_SECRET).'),
    connectionMappings: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Maps Sigma internal connection UUIDs to ktx warehouse connection IDs. ' +
          'When set, projected semantic-layer sources land under the mapped warehouse connection ' +
          'instead of the Sigma connection, enabling sl_validate. ' +
          'Find UUIDs in data model specs under source.connectionId.',
      ),
    workbookFilter: z
      .object({
        includeArchived: z.boolean().default(false),
        includeExplorations: z.boolean().default(false),
        updatedSince: z.string().optional().describe('ISO 8601 date string. Only workbooks updated on or after this date are ingested.'),
      })
      .optional()
      .describe('Filters applied when listing workbooks during ingest. Defaults exclude archived and exploration workbooks.'),
    dataModelFilter: z
      .object({
        updatedSince: z.string().optional().describe('ISO 8601 date string. Only data models updated on or after this date are fetched.'),
      })
      .optional()
      .describe('Filters applied when listing data models during ingest.'),
  })
  .describe('Sigma Computing API connection for ingesting data models.');

export const connectionConfigSchema = z.discriminatedUnion('driver', [
  ...warehouseConnectionSchemas,
  mongodbConnectionSchema,
  metabaseConnectionSchema,
  lookerConnectionSchema,
  lookmlConnectionSchema,
  notionConnectionSchema,
  gdriveConnectionSchema,
  dbtConnectionSchema,
  metricflowConnectionSchema,
  sigmaConnectionSchema,
]);
