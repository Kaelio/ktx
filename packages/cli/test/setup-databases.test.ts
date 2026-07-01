import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initKtxProject, loadKtxProject } from '../src/context/project/project.js';
import { parseKtxProjectConfig } from '../src/context/project/config.js';
import { readKtxSetupState, writeKtxSetupState } from '../src/context/project/setup-config.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  managedDaemonOptionsForSetupQueryHistoryPicker,
  type KtxSetupDatabaseDriver,
  type KtxSetupDatabasesDeps,
  type KtxSetupDatabasesPromptAdapter,
  runKtxSetupDatabasesStep,
} from '../src/setup-databases.js';
import type { KtxCliIo } from '../src/cli-runtime.js';
import type {
  DatabaseScopePickResult,
  PickDatabaseScopeArgs,
} from '../src/database-tree-picker.js';
import type { KtxSetupPromptOption } from '../src/setup-prompts.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

type ScopePick =
  | 'back'
  | 'enable-all'
  | { schemas: string[]; tables: string[] | 'back' };

interface PickerStubs {
  pickDatabaseScope: KtxSetupDatabasesDeps['pickDatabaseScope'];
  scopeCalls: PickDatabaseScopeArgs[];
}

function makePickerStubs(options: { scopes?: ScopePick[] } = {}): PickerStubs {
  const queue: ScopePick[] = [...(options.scopes ?? [])];
  const scopeCalls: PickDatabaseScopeArgs[] = [];
  return {
    scopeCalls,
    pickDatabaseScope: vi.fn(async (args: PickDatabaseScopeArgs): Promise<DatabaseScopePickResult> => {
      scopeCalls.push(args);
      const next = queue.shift();
      if (next === undefined || next === 'enable-all') {
        const schemas = args.initialSchemas && args.initialSchemas.length > 0 ? [...args.initialSchemas] : [...args.schemas];
        const discovered = await args.listTablesForSchemas(schemas);
        const enabledTables = discovered.map((t) => `${t.schema}.${t.name}`);
        const activeSchemas = args.supportsSchemaScope
          ? Array.from(new Set(discovered.map((t) => t.schema)))
          : [];
        return { kind: 'selected', activeSchemas, enabledTables };
      }
      if (next === 'back') {
        return { kind: 'back' };
      }
      await args.listTablesForSchemas(next.schemas);
      if (next.tables === 'back') {
        return { kind: 'back' };
      }
      return {
        kind: 'selected',
        activeSchemas: args.supportsSchemaScope ? next.schemas : [],
        enabledTables: next.tables,
      };
    }),
  };
}

function makePromptAdapter(options: {
  multiselectValues?: string[][];
  selectValues?: string[];
  textValues?: (string | undefined)[];
  passwordValues?: (string | undefined)[];
}): KtxSetupDatabasesPromptAdapter {
  const multiselectValues = [...(options.multiselectValues ?? [])];
  const selectValues = [...(options.selectValues ?? [])];
  const textValues = [...(options.textValues ?? [])];
  const passwordValues = [...(options.passwordValues ?? [])];
  return {
    multiselect: vi.fn(async () => multiselectValues.shift() ?? ['postgres']),
    autocompleteMultiselect: vi.fn(async (options) => {
      if (multiselectValues.length > 0) {
        return multiselectValues.shift() ?? [];
      }
      if (options.initialValues && options.initialValues.length > 0) {
        return options.initialValues;
      }
      return options.options.length > 0
        ? options.options.map((option: { value: string }) => option.value)
        : ['back'];
    }),
    select: vi.fn(async ({ message }) => {
      if (message.startsWith('Enable all tables in ') && message.includes(', or refine tables?')) {
        return 'save';
      }
      if (message.includes('How much database context should ktx build?')) {
        const nextValue = selectValues[0];
        return nextValue === 'fast' || nextValue === 'deep' || nextValue === 'back'
          ? (selectValues.shift() ?? 'fast')
          : 'fast';
      }
      return selectValues.shift() ?? 'finish';
    }),
    text: vi.fn(async () => (textValues.length > 0 ? textValues.shift() : '')),
    password: vi.fn(async () => (passwordValues.length > 0 ? passwordValues.shift() : '')),
    cancel: vi.fn(),
  };
}

function connectionNamePrompt(label: string): string {
  return `Name this ${label} connection\nktx will use this short name in commands and config. You can rename it now.`;
}

function textInputPrompt(message: string): string {
  const normalized = message.replace(/\n+$/, '');
  if (!normalized.includes('\n')) {
    return `${normalized}\n│  Press Escape to go back.\n│`;
  }
  const [title, ...bodyLines] = normalized.split('\n');
  return `${title}\n│\n│  ${bodyLines.join('\n│  ')}\n│  Press Escape to go back.\n│`;
}

function queryHistoryFromConfig(connection: unknown): {
  filters?: { serviceAccounts?: unknown; dropTrivialProbes?: boolean };
} | undefined {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    return undefined;
  }
  const context = (connection as { context?: unknown }).context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return undefined;
  }
  const queryHistory = (context as { queryHistory?: unknown }).queryHistory;
  return queryHistory && typeof queryHistory === 'object' && !Array.isArray(queryHistory)
    ? (queryHistory as { filters?: { serviceAccounts?: unknown; dropTrivialProbes?: boolean } })
    : undefined;
}

describe('setup databases step', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-databases-'));
    await initKtxProject({ projectDir: tempDir });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('builds managed daemon options for setup query-history SQL analysis', () => {
    const io = makeIo();

    expect(
      managedDaemonOptionsForSetupQueryHistoryPicker({
        projectDir: tempDir,
        args: {
          inputMode: 'disabled',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        io: io.io,
      }),
    ).toEqual({
      cliVersion: '0.2.0',
      projectDir: tempDir,
      installPolicy: 'auto',
      io: io.io,
    });
  });

  it('defaults managed daemon setup options when the database step is called directly', () => {
    const io = makeIo();

    expect(
      managedDaemonOptionsForSetupQueryHistoryPicker({
        projectDir: tempDir,
        args: {
          inputMode: 'disabled',
        },
        io: io.io,
      }),
    ).toMatchObject({
      cliVersion: expect.any(String),
      projectDir: tempDir,
      installPolicy: 'never',
      io: io.io,
    });

    expect(
      managedDaemonOptionsForSetupQueryHistoryPicker({
        projectDir: tempDir,
        args: {
          inputMode: 'auto',
        },
        io: io.io,
      }),
    ).toMatchObject({
      cliVersion: expect.any(String),
      projectDir: tempDir,
      installPolicy: 'prompt',
      io: io.io,
    });
  });

  it('shows every supported database in the interactive checklist', async () => {
    const prompts = makePromptAdapter({ multiselectValues: [['back']] });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.multiselect).toHaveBeenCalledWith({
      message:
        'Which databases should ktx connect to?\n' +
        'Up/Down to move, Tab to select or unselect, Enter to confirm, Escape to go back, Ctrl+C to exit.',
      options: [
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'bigquery', label: 'BigQuery' },
        { value: 'snowflake', label: 'Snowflake' },
        { value: 'mysql', label: 'MySQL' },
        { value: 'clickhouse', label: 'ClickHouse' },
        { value: 'sqlserver', label: 'SQL Server' },
        { value: 'mongodb', label: 'MongoDB' },
        { value: 'sqlite', label: 'SQLite' },
        { value: 'duckdb', label: 'DuckDB' },
      ],
      required: true,
    });
  });

  it('lets Back from connection method selection return to database selection when adding a new driver', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      selectValues: ['back'],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'How do you want to connect to PostgreSQL?',
      options: [
        { value: 'url', label: 'Paste a connection URL' },
        { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prompts.multiselect).mock.calls[1]?.[0].message).toBe(
      'Which databases should ktx connect to?\n' +
        'Up/Down to move, Tab to select or unselect, Enter to confirm, Escape to go back, Ctrl+C to exit.',
    );
  });

  it('offers connection URL paste first for URL-capable databases', async () => {
    const cases: Array<{ driver: KtxSetupDatabaseDriver; label: string }> = [
      { driver: 'postgres', label: 'PostgreSQL' },
      { driver: 'mysql', label: 'MySQL' },
      { driver: 'clickhouse', label: 'ClickHouse' },
      { driver: 'sqlserver', label: 'SQL Server' },
    ];

    for (const testCase of cases) {
      const prompts = makePromptAdapter({
        selectValues: ['back'],
      });

      const result = await runKtxSetupDatabasesStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          databaseDrivers: [testCase.driver],
          skipDatabases: false,
          databaseSchemas: [],
        },
        makeIo().io,
        { prompts },
      );

      expect(result.status).toBe('back');
      expect(prompts.select).toHaveBeenCalledWith({
        message: `How do you want to connect to ${testCase.label}?`,
        options: [
          { value: 'url', label: 'Paste a connection URL' },
          { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
          { value: 'back', label: 'Back' },
        ],
      });
    }
  });

  it('lets Back leave database setup when the driver came from flags', async () => {
    const prompts = makePromptAdapter({ selectValues: ['back'] });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        skipDatabases: false,
        databaseSchemas: [],
      },
      makeIo().io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(prompts.select).toHaveBeenCalledTimes(1);
  });

  it('labels existing database connections with the database type', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    const prompts = makePromptAdapter({ selectValues: ['back'] });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        skipDatabases: false,
        databaseSchemas: [],
      },
      makeIo().io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Configure PostgreSQL',
      options: [
        { value: 'existing:warehouse', label: 'Keep existing PostgreSQL connection: warehouse' },
        { value: 'edit:warehouse', label: 'Edit PostgreSQL connection: warehouse' },
        { value: 'new', label: 'Add another PostgreSQL connection' },
        { value: 'back', label: 'Back' },
      ],
    });
  });

  it('uses a database-specific editable connection name for new interactive connections', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(prompts.text).toHaveBeenNthCalledWith(1, {
      message: textInputPrompt(connectionNamePrompt('PostgreSQL')),
      placeholder: 'postgres-warehouse',
      initialValue: 'postgres-warehouse',
    });
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'postgres-warehouse', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'postgres-warehouse', expect.anything());
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.connections['postgres-warehouse']).toEqual({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    });
  });

  it('emits debug telemetry when setup writes a database connection', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('KTX_TELEMETRY_DISABLED', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('CI', '');
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const listSchemas = vi.fn(async () => []);
    const listTables = vi.fn(async () => []);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        listSchemas,
        listTables,
      },
    );

    expect(result.status).toBe('ready');
    expect(io.stderr()).toContain('"event":"connection_added"');
    expect(io.stderr()).toContain('"driver":"postgres"');
    expect(io.stderr()).toContain('"isDemoConnection":false');
    expect(io.stderr()).not.toContain(tempDir);
  });

  it('tells users Escape goes back in free-text connection prompts', async () => {
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL'],
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      makeIo().io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.text).toHaveBeenNthCalledWith(1, {
      message: textInputPrompt(connectionNamePrompt('PostgreSQL')),
      placeholder: 'postgres-warehouse',
      initialValue: 'postgres-warehouse',
    });
    expect(prompts.text).toHaveBeenNthCalledWith(2, {
      message: textInputPrompt('PostgreSQL connection URL'),
    });
  });

  it('uses clear setup prompts for every new database connection type', async () => {
    const cases: Array<{
      driver: KtxSetupDatabaseDriver;
      selectValues?: string[];
      textValues: string[];
      passwordValues?: string[];
      expectedTextPrompts: Array<{ message: string; placeholder?: string; initialValue?: string }>;
      expectedPasswordPrompts?: Array<{ message: string }>;
    }> = [
      {
        driver: 'sqlite',
        textValues: ['', './warehouse.sqlite'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('SQLite'),
            placeholder: 'sqlite-local',
            initialValue: 'sqlite-local',
          },
          {
            message: 'SQLite database file\nEnter a relative or absolute path, for example ./warehouse.sqlite.',
          },
        ],
      },
      {
        driver: 'postgres',
        selectValues: ['url'],
        textValues: ['', 'env:DATABASE_URL'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('PostgreSQL'),
            placeholder: 'postgres-warehouse',
            initialValue: 'postgres-warehouse',
          },
          {
            message: 'PostgreSQL connection URL',
          },
        ],
      },
      {
        driver: 'mysql',
        selectValues: ['url'],
        textValues: ['', 'env:MYSQL_DATABASE_URL'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('MySQL'),
            placeholder: 'mysql-warehouse',
            initialValue: 'mysql-warehouse',
          },
          {
            message: 'MySQL connection URL',
          },
        ],
      },
      {
        driver: 'clickhouse',
        selectValues: ['url'],
        textValues: ['', 'env:CLICKHOUSE_URL'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('ClickHouse'),
            placeholder: 'clickhouse-warehouse',
            initialValue: 'clickhouse-warehouse',
          },
          {
            message: 'ClickHouse connection URL',
          },
        ],
      },
      {
        driver: 'sqlserver',
        selectValues: ['url'],
        textValues: ['', 'env:SQLSERVER_DATABASE_URL'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('SQL Server'),
            placeholder: 'sqlserver-warehouse',
            initialValue: 'sqlserver-warehouse',
          },
          {
            message: 'SQL Server connection URL',
          },
        ],
      },
      {
        driver: 'bigquery',
        selectValues: ['no'],
        textValues: ['', '/path/to/service-account.json', ''],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('BigQuery'),
            placeholder: 'bigquery-warehouse',
            initialValue: 'bigquery-warehouse',
          },
          {
            message: 'Path to service account JSON file',
          },
          {
            message: 'BigQuery location\nPress Enter for US, or enter a location like EU.',
            placeholder: 'US',
            initialValue: 'US',
          },
        ],
      },
      {
        driver: 'snowflake',
        selectValues: ['password', 'no'],
        textValues: ['', 'env:SNOWFLAKE_ACCOUNT', 'ANALYTICS_WH', 'ANALYTICS', 'env:SNOWFLAKE_USER', ''],
        passwordValues: ['env:SNOWFLAKE_PASSWORD'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('Snowflake'),
            placeholder: 'snowflake-warehouse',
            initialValue: 'snowflake-warehouse',
          },
          {
            message: 'Snowflake account identifier',
          },
          {
            message: 'Snowflake warehouse\nFor example ANALYTICS_WH.',
          },
          {
            message: 'Snowflake database name',
          },
          {
            message: 'Snowflake username',
          },
          {
            message: 'Snowflake role (optional)\nPress Enter to skip.',
          },
        ],
        expectedPasswordPrompts: [
          {
            message: 'Snowflake password',
          },
        ],
      },
    ];

    for (const testCase of cases) {
      const prompts = makePromptAdapter({
        selectValues: testCase.selectValues ?? ['new'],
        textValues: testCase.textValues,
        passwordValues: testCase.passwordValues,
      });
      const result = await runKtxSetupDatabasesStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          databaseDrivers: [testCase.driver],
          databaseSchemas: [],
          skipDatabases: false,
        },
        makeIo().io,
        {
          prompts,
          testConnection: vi.fn(async () => 0),
          scanConnection: vi.fn(async () => 0),
          listSchemas: vi.fn(async () => []),
          listTables: vi.fn(async () => []),
        },
      );

      expect(result.status).toBe('ready');
      expect(vi.mocked(prompts.text).mock.calls.map(([options]) => options)).toEqual(
        testCase.expectedTextPrompts.map((expectedPrompt) => ({
          ...expectedPrompt,
          message: textInputPrompt(expectedPrompt.message),
        })),
      );
      if (testCase.expectedPasswordPrompts) {
        expect(vi.mocked(prompts.password).mock.calls.map(([options]) => options)).toEqual(
          testCase.expectedPasswordPrompts.map((expectedPrompt) => ({
            ...expectedPrompt,
            message: textInputPrompt(expectedPrompt.message),
          })),
        );
      }
    }
  });

  it('lets Back from connection method selection return to database selection', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      selectValues: ['back'],
      textValues: [''],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => []);
    const listTables = vi.fn(async () => []);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection, listSchemas, listTables },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenNthCalledWith(1, {
      message: 'How do you want to connect to PostgreSQL?',
      options: [
        { value: 'url', label: 'Paste a connection URL' },
        { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('shows a configured database menu instead of the type checklist when a database exists', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({ multiselectValues: [['back']], selectValues: ['continue'] });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Databases configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'skip-sources', label: 'Skip context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('can skip context sources from the configured database menu', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({ selectValues: ['skip-sources'] });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['warehouse'],
      skipSources: true,
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('preserves existing database ids when adding another database from the configured menu', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      selectValues: ['add', 'url', 'continue'],
      multiselectValues: [['mysql']],
      textValues: ['', 'env:MYSQL_DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['warehouse', 'mysql-warehouse'],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(1);
    expect(prompts.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      initialValues: ['postgres'],
      required: true,
    }));
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Databases configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'skip-sources', label: 'Skip context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'mysql-warehouse', expect.anything());
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.setup?.database_connection_ids).toEqual(['warehouse', 'mysql-warehouse']);
  });

  it('lets users add another database after completing the first one', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['mysql']],
      selectValues: ['url', 'add', 'url', 'continue'],
      textValues: ['', 'env:DATABASE_URL', '', 'env:MYSQL_DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => []);
    const listTables = vi.fn(async () => []);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection, listSchemas, listTables },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['postgres-warehouse', 'mysql-warehouse'],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(prompts.multiselect).toHaveBeenNthCalledWith(2, expect.objectContaining({
      initialValues: ['postgres'],
      required: true,
    }));
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Databases configured: postgres-warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'skip-sources', label: 'Skip context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.database_connection_ids).toEqual(['postgres-warehouse', 'mysql-warehouse']);
  });

  it('returns to configured primary menu when pressing back on driver selection after adding a source', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      selectValues: ['url', 'add', 'continue'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['postgres-warehouse'],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(prompts.multiselect).toHaveBeenNthCalledWith(2, expect.objectContaining({
      initialValues: ['postgres'],
      required: true,
    }));
    expect(io.stdout()).not.toContain('ktx cannot work without at least one database');
    expect(prompts.select).toHaveBeenNthCalledWith(3, {
      message: 'Databases configured: postgres-warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'skip-sources', label: 'Skip context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
  });

  it('returns to configured primary menu when pressing back on driver selection with pre-existing source', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const io = makeIo();
    const prompts = makePromptAdapter({
      multiselectValues: [['back']],
      selectValues: ['add', 'continue'],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      io.io,
      { prompts },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(prompts.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      initialValues: ['postgres'],
      required: true,
    }));
    expect(io.stdout()).not.toContain('ktx cannot work without at least one database');
    expect(prompts.select).toHaveBeenNthCalledWith(2, {
      message: 'Databases configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'skip-sources', label: 'Skip context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
  });

  it('returns from database edit selection back to the configured source menu', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      selectValues: ['edit', 'back', 'continue'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(prompts.select).toHaveBeenNthCalledWith(2, {
      message: 'Database to edit',
      options: [
        { value: 'warehouse', label: 'warehouse (PostgreSQL)' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(prompts.select).toHaveBeenNthCalledWith(3, {
      message: 'Databases configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'skip-sources', label: 'Skip context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('reruns table selection after editing schema scope so stale enabled tables are removed', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      textValues: ['env:DATABASE_URL'],
    });
    let primaryMenuCount = 0;
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') {
        primaryMenuCount += 1;
        return primaryMenuCount === 1 ? 'edit' : 'continue';
      }
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      return 'back';
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['analytics', 'public']);
    const listTables = vi.fn(async () => [{ catalog: null, schema: 'analytics', name: 'customers', kind: 'table' as const }]);
    const pickers = makePickerStubs({
      scopes: [{ schemas: ['analytics'], tables: ['analytics.customers'] }],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection,
        scanConnection,
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(prompts.text).toHaveBeenCalledWith({
      message: textInputPrompt('PostgreSQL connection URL'),
      placeholder: 'env:DATABASE_URL',
      initialValue: 'env:DATABASE_URL',
    });
    expect(listTables).toHaveBeenCalledWith(tempDir, 'warehouse', ['analytics']);
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      schemas: ['analytics'],
      enabled_tables: ['analytics.customers'],
    });
  });

  it('preselects existing schema and table choices when editing a database', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.customers',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      textValues: ['env:DATABASE_URL'],
    });
    let primaryMenuCount = 0;
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') {
        primaryMenuCount += 1;
        return primaryMenuCount === 1 ? 'edit' : 'continue';
      }
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      return 'back';
    });
    const listSchemas = vi.fn(async () => ['orbit_analytics', 'orbit_raw', 'public']);
    const listTables = vi.fn(async () => [
      { catalog: null, schema: 'public', name: 'customers', kind: 'table' as const },
      { catalog: null, schema: 'public', name: 'orders', kind: 'table' as const },
      { catalog: null, schema: 'public', name: 'products', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({
      scopes: [{ schemas: ['public'], tables: ['public.customers', 'public.orders'] }],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(pickers.scopeCalls).toHaveLength(1);
    expect(pickers.scopeCalls[0]).toMatchObject({
      connectionId: 'warehouse',
      schemaNoun: 'schema',
      supportsSchemaScope: true,
      existing: { enabledTables: ['public.customers', 'public.orders'] },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      schemas: ['public'],
      enabled_tables: ['public.customers', 'public.orders'],
    });
  });

  it('returns to the configured primary menu when backing out of schema review during edit', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      textValues: ['env:DATABASE_URL'],
    });
    let primaryMenuCount = 0;
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') {
        primaryMenuCount += 1;
        return primaryMenuCount === 1 ? 'edit' : 'continue';
      }
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      return 'back';
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['analytics', 'public']);
    const listTables = vi.fn(async () => [
      { catalog: null, schema: 'analytics', name: 'customers', kind: 'table' as const },
      { catalog: null, schema: 'public', name: 'orders', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({ scopes: ['back'] });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection,
        scanConnection,
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(primaryMenuCount).toBe(2);
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    expect(scanConnection).not.toHaveBeenCalled();
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      enabled_tables: ['public.orders'],
    });
  });

  it('returns to the configured primary menu when backing out of table review during edit', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({ textValues: ['env:DATABASE_URL'] });
    let primaryMenuCount = 0;
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') {
        primaryMenuCount += 1;
        return primaryMenuCount === 1 ? 'edit' : 'continue';
      }
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      return 'back';
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['public']);
    const listTables = vi.fn(async () => [
      { catalog: null, schema: 'public', name: 'customers', kind: 'table' as const },
      { catalog: null, schema: 'public', name: 'orders', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({ scopes: [{ schemas: ['public'], tables: 'back' }] });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection,
        scanConnection,
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(primaryMenuCount).toBe(2);
    expect(listTables).toHaveBeenCalledWith(tempDir, 'warehouse', ['public']);
    expect(scanConnection).not.toHaveBeenCalled();
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      enabled_tables: ['public.orders'],
    });
  });

  it('restores an existing database edit when the follow-up scan fails', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      textValues: ['env:DATABASE_URL'],
    });
    let primaryMenuCount = 0;
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') {
        primaryMenuCount += 1;
        return primaryMenuCount === 1 ? 'edit' : 'continue';
      }
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      if (options.message === 'Connection setup failed for warehouse') return 'back';
      return 'back';
    });
    const listTables = vi.fn(async () => [
      { catalog: null, schema: 'public', name: 'customers', kind: 'table' as const },
      { catalog: null, schema: 'public', name: 'orders', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({ scopes: ['enable-all'] });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 1),
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      enabled_tables: ['public.orders'],
    });
  });

  it('recovers from an interactive database edit failure by re-entering details', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  analytics:',
        '    driver: postgres',
        '    url: env:OLD_DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - analytics',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['edit', 'analytics', 'url', 'no', 're-enter', 'url', 'no', 'continue'],
      textValues: ['env:BAD_DATABASE_URL', 'env:FIXED_DATABASE_URL'],
    });
    let attempts = 0;

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => {
          attempts += 1;
          return attempts === 1 ? 1 : 0;
        }),
        scanConnection: vi.fn(async () => 0),
        listSchemas: vi.fn(async () => ['public']),
        listTables: vi.fn(async () => [{ catalog: null, schema: 'public', name: 'orders', kind: 'table' as const }]),
      },
    );

    expect(result.status).toBe('ready');
    expect(vi.mocked(prompts.select)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Connection setup failed for analytics',
        options: expect.arrayContaining([
          { value: 'retry', label: 'Retry connection test' },
          { value: 're-enter', label: 'Re-enter connection details' },
          { value: 'back', label: 'Back' },
        ]),
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.analytics).toMatchObject({
      driver: 'postgres',
      url: 'env:FIXED_DATABASE_URL',
    });
  });

  it('re-enters details after an interactive existing database validation failure', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:OLD_DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['existing:warehouse', 'no', 're-enter', 'url', 'no'],
      textValues: ['env:FIXED_DATABASE_URL'],
    });
    let attempts = 0;

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => {
          attempts += 1;
          return attempts === 1 ? 1 : 0;
        }),
        scanConnection: vi.fn(async () => 0),
        listSchemas: vi.fn(async () => ['public']),
        listTables: vi.fn(async () => [
          { catalog: null, schema: 'public', name: 'orders', kind: 'table' as const },
        ]),
      },
    );

    expect(result.status).toBe('ready');
    expect(vi.mocked(prompts.select)).toHaveBeenCalledWith({
      message: 'How do you want to connect to PostgreSQL?',
      options: [
        { value: 'url', label: 'Paste a connection URL' },
        { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(vi.mocked(prompts.select)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Connection setup failed for warehouse',
        options: expect.arrayContaining([
          { value: 'retry', label: 'Retry connection test' },
          { value: 're-enter', label: 'Re-enter connection details' },
          { value: 'skip', label: 'Skip this connection' },
          { value: 'back', label: 'Back' },
        ]),
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      driver: 'postgres',
      url: 'env:FIXED_DATABASE_URL',
    });
  });

  it('restores the previous database config when backing out of a failed edit', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  analytics:',
        '    driver: postgres',
        '    url: env:OLD_DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - analytics',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['edit', 'analytics', 'url', 'no', 'back', 'continue'],
      textValues: ['env:BAD_DATABASE_URL'],
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => 1),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.analytics).toMatchObject({
      driver: 'postgres',
      url: 'env:OLD_DATABASE_URL',
    });
  });

  it('keeps scripted database setup fail-fast without rolling back attempted config', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  analytics:',
        '    driver: postgres',
        '    url: env:OLD_DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['analytics'],
        databaseSchemas: [],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 1),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('failed');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.analytics).toMatchObject({
      driver: 'postgres',
      url: 'env:OLD_DATABASE_URL',
      context: {
        queryHistory: {
          enabled: true,
        },
      },
    });
  });

  it('keeps scripted database ids fail-fast even when input mode is auto', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  analytics:',
        '    driver: postgres',
        '    url: env:OLD_DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const prompts = makePromptAdapter({});
    vi.mocked(prompts.select).mockImplementation(async ({ message }) => {
      if (message === 'Connection setup failed for analytics') {
        throw new Error('scripted selected-id setup opened the recovery menu');
      }
      return 'finish';
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseConnectionIds: ['analytics'],
        databaseSchemas: [],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => 1),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('failed');
    expect(prompts.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Connection setup failed for analytics' }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.analytics).toMatchObject({
      driver: 'postgres',
      url: 'env:OLD_DATABASE_URL',
      context: {
        queryHistory: {
          enabled: true,
        },
      },
    });
  });

  it('lets Escape from connection fields return to connection method selection', async () => {
    const prompts = makePromptAdapter({
      selectValues: ['fields', 'url'],
      textValues: ['', undefined, 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    const selectMessages = vi.mocked(prompts.select).mock.calls.map(([options]) => options.message);
    expect(selectMessages.filter((message) => message === 'How do you want to connect to PostgreSQL?')).toHaveLength(2);
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'postgres-warehouse', expect.anything());
  });

  it('explains where Back goes after missing PostgreSQL field input', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      selectValues: ['fields', 'back'],
      textValues: ['', 'db.example.com', '5432', ''],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenNthCalledWith(2, {
      message:
        'Some PostgreSQL connection details are missing.\n' +
        'Continue entering details, or go back to database selection.',
      options: [
        { value: 'retry', label: 'Continue entering PostgreSQL details' },
        { value: 'back', label: 'Back to database selection' },
      ],
    });
  });

  it('lets Escape from connection name return to database selection', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      textValues: [undefined],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseSchemas: [],
        skipDatabases: false,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('back');
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(prompts.select).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('builds a Postgres connection from individual fields and stores password in .ktx/secrets', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['fields'],
      textValues: ['', 'db.example.com', '', 'analytics', 'readonly'],
      passwordValues: ['s3cret'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    const connection = config.connections['postgres-warehouse'];
    expect(connection).toMatchObject({
      driver: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'analytics',
      username: 'readonly',
    });
    expect(connection.password).toMatch(/^file:/);
    const secretPath = join(tempDir, '.ktx/secrets/postgres-warehouse-password');
    await expect(readFile(secretPath, 'utf-8')).resolves.toBe('s3cret\n');
    if (process.platform !== 'win32') {
      expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('stores credential-bearing pasted URLs in .ktx/secrets automatically', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'postgresql://myuser:s3cret@db.example.com:5432/analytics'], // pragma: allowlist secret
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    const connection = config.connections['postgres-warehouse'];
    expect(connection.url).toBe(`file:${resolve(tempDir, '.ktx/secrets/postgres-warehouse-url')}`);
    expect(connection.driver).toBe('postgres');
    const secretContent = await readFile(join(tempDir, '.ktx/secrets/postgres-warehouse-url'), 'utf-8');
    expect(secretContent).toBe('postgresql://myuser:s3cret@db.example.com:5432/analytics\n'); // pragma: allowlist secret
  });

  it('summarizes connection test and structural scan output during setup', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
      commandIo.stdout.write('Connection test passed: postgres-warehouse\n');
      commandIo.stdout.write('Driver: postgres\n');
      commandIo.stdout.write('Status: ok\n');
      return 0;
    });
    const scanConnection = vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
      commandIo.stdout.write('Scanning postgres-warehouse for context. Large databases can take a while.\n');
      commandIo.stdout.write('[5%] Preparing scan\n');
      commandIo.stdout.write('[15%] Inspecting database schema\n');
      commandIo.stdout.write('[55%] Semantic layer comparison found 2 changes across 2 tables\n');
      commandIo.stdout.write('[70%] Writing schema artifacts\n');
      commandIo.stdout.write('[100%] Scan completed\n');
      commandIo.stdout.write('✓ ktx scan completed\n');
      commandIo.stdout.write('Status: done\n');
      commandIo.stdout.write('Run: local-moywh3ky\n');
      commandIo.stdout.write('Connection: postgres-warehouse\n');
      commandIo.stdout.write('Mode: structural\n');
      commandIo.stdout.write('Sync: 2026-05-09-221301-local-moywh3ky\n');
      commandIo.stdout.write('Dry run: no\n\n');
      commandIo.stdout.write('What changed\n');
      commandIo.stdout.write('  Semantic layer comparison found 2 changes across 2 tables\n');
      commandIo.stdout.write('  New tables: 2\n');
      commandIo.stdout.write('  Changed tables: 0\n');
      commandIo.stdout.write('  Removed tables: 0\n');
      commandIo.stdout.write('  Unchanged tables: 0\n\n');
      commandIo.stdout.write('Needs attention\n');
      commandIo.stdout.write('  None\n\n');
      commandIo.stdout.write('Artifacts\n');
      commandIo.stdout.write(
        '  Report: raw-sources/postgres-warehouse/live-database/2026-05-09-221301-local-moywh3ky/scan-report.json\n',
      );
      commandIo.stdout.write('  Raw sources: raw-sources/postgres-warehouse/live-database/2026-05-09-221301-local-moywh3ky\n');
      commandIo.stdout.write('  Schema shards: 1\n\n');
      commandIo.stdout.write('Next:\n');
      commandIo.stdout.write(`  ktx status --project-dir ${tempDir} local-moywh3ky\n`);
      return 0;
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(io.stdout()).toContain(
      [
        '◇  Testing postgres-warehouse',
        '│  ✓ Connection test passed',
        '│  Driver: PostgreSQL',
        '│',
      ].join('\n'),
    );
    expect(io.stdout()).not.toContain('Tables: 2');
    expect(io.stdout()).toContain('◇  Building schema context for postgres-warehouse');
    expect(io.stdout()).toContain('│  Running database scan…');
    expect(io.stdout()).toContain('◇  Schema context complete for postgres-warehouse');
    expect(io.stdout()).toContain('│  Changes: 2 new tables');
    expect(io.stdout()).toContain('◇  Database ready');
    expect(io.stdout()).not.toContain(['Primary source', 'ready'].join(' '));
    expect(io.stdout()).toContain('│  postgres-warehouse · PostgreSQL · schema context complete');
    expect(io.stdout()).not.toContain('Scanning postgres-warehouse');
    expect(io.stdout()).not.toContain('Scan complete for postgres-warehouse');
    expect(io.stdout()).not.toContain('structural scan complete');
    expect(io.stdout()).not.toContain('Report: raw-sources');
    expect(io.stdout()).not.toContain('live-database');
    expect(io.stdout()).not.toContain('[5%] Preparing scan');
    expect(io.stdout()).not.toContain('What changed');
    expect(io.stdout()).not.toContain('Next:');
  });

  it('normalizes $ENV_VAR syntax to env: references in pasted URLs', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', '$DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['postgres-warehouse']).toMatchObject({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    });
  });

  it('offers schema scope discovery for MySQL and writes selected schemas', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['mysql']],
      selectValues: ['url', 'continue'],
      textValues: ['mysql-warehouse', 'mysql://reader@localhost/analytics'],
    });
    const listSchemas = vi.fn(async () => ['analytics', 'mart']);
    const listTables = vi.fn(async (_projectDir: string, _connectionId: string, schemas?: string[]) =>
      (schemas ?? []).map((schema) => ({ catalog: null, schema, name: 'orders', kind: 'table' as const })),
    );
    const pickDatabaseScope = vi.fn(async (args: PickDatabaseScopeArgs) => {
      const scopedArgs = args as PickDatabaseScopeArgs & {
        schemaSuggestion: { suggested: Set<string> };
      };
      expect(args.schemaNoun).toBe('database');
      expect(args.schemas).toEqual(['analytics', 'mart']);
      expect(scopedArgs.schemaSuggestion.suggested).toEqual(new Set(['analytics', 'mart']));
      return { kind: 'selected' as const, activeSchemas: ['mart'], enabledTables: ['mart.orders'] };
    });

    await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts, testConnection: vi.fn(async () => 0), scanConnection: vi.fn(async () => 0), listSchemas, listTables, pickDatabaseScope },
    );

    const project = await loadKtxProject({ projectDir: tempDir });
    expect(project.config.connections['mysql-warehouse']).toMatchObject({
      driver: 'mysql',
      schemas: ['mart'],
      enabled_tables: ['mart.orders'],
    });
  });

  it('maps ClickHouse scripted database schema input to databases and preserves database', async () => {
    await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        skipDatabases: false,
        databaseDrivers: ['clickhouse'],
        databaseConnectionId: 'clickhouse-warehouse',
        databaseUrl: 'clickhouse://reader@localhost/analytics',
        databaseSchemas: ['analytics', 'mart'],
      },
      makeIo().io,
      { testConnection: vi.fn(async () => 0), scanConnection: vi.fn(async () => 0) },
    );

    const project = await loadKtxProject({ projectDir: tempDir });
    expect(project.config.connections['clickhouse-warehouse']).toMatchObject({
      driver: 'clickhouse',
      database: 'analytics',
      databases: ['analytics', 'mart'],
    });
    expect(project.config.connections['clickhouse-warehouse']).not.toHaveProperty('schemas');
  });

  it('does not prompt for a bootstrap BigQuery dataset before scope discovery', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['bigquery']],
      selectValues: ['no', 'continue'],
      textValues: ['bigquery-warehouse', '/tmp/service-account.json', 'US'],
    });
    const listSchemas = vi.fn(async () => ['analytics']);
    const listTables = vi.fn(async () => [{ catalog: 'project-1', schema: 'analytics', name: 'orders', kind: 'table' as const }]);
    const pickDatabaseScope = vi.fn(async () => ({
      kind: 'selected' as const,
      activeSchemas: ['analytics'],
      enabledTables: ['analytics.orders'],
    }));

    await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts, testConnection: vi.fn(async () => 0), scanConnection: vi.fn(async () => 0), listSchemas, listTables, pickDatabaseScope },
    );

    const textMessages = vi.mocked(prompts.text).mock.calls.map(([options]) => options.message);
    expect(textMessages).not.toContain(textInputPrompt('BigQuery dataset\nFor example analytics.'));
  });

  it('prompts for discovered Postgres schemas before the first scan', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async asyncScanProjectDir => {
      const config = parseKtxProjectConfig(await readFile(join(asyncScanProjectDir, 'ktx.yaml'), 'utf-8'));
      expect(config.connections['postgres-warehouse']).toMatchObject({
        schemas: ['orbit_analytics', 'orbit_raw'],
      });
      return 0;
    });
    const listSchemas = vi.fn(async () => ['orbit_analytics', 'orbit_raw', 'public']);
    const listTables = vi.fn(async () => [
      { catalog: null, schema: 'orbit_analytics', name: 'events', kind: 'table' as const },
      { catalog: null, schema: 'orbit_raw', name: 'inputs', kind: 'table' as const },
      { catalog: null, schema: 'public', name: 'misc', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({
      scopes: [
        {
          schemas: ['orbit_analytics', 'orbit_raw'],
          tables: ['orbit_analytics.events', 'orbit_raw.inputs'],
        },
      ],
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection,
        scanConnection,
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result.status).toBe('ready');
    expect(listSchemas).toHaveBeenCalledWith(tempDir, 'postgres-warehouse');
    expect(pickers.scopeCalls).toHaveLength(1);
    expect(pickers.scopeCalls[0]).toMatchObject({
      connectionId: 'postgres-warehouse',
      schemaNoun: 'schema',
      schemaNounPlural: 'schemas',
      schemas: ['orbit_analytics', 'orbit_raw', 'public'],
      schemaSuggestion: { excluded: new Set(), suggested: new Set() },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['postgres-warehouse']).toMatchObject({
      schemas: ['orbit_analytics', 'orbit_raw'],
    });
    expect(io.stdout()).toContain('✓ orbit_analytics, orbit_raw');
  });

  it('falls back to comma-separated free-text when listSchemas fails interactively', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL', 'orbit_analytics, orbit_raw'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => {
      throw new Error('permission denied to list schemas');
    });
    const listTables = vi.fn(async (_projectDir: string, _connectionId: string, schemas?: string[]) =>
      (schemas ?? []).map((schema) => ({ catalog: null, schema, name: 'events', kind: 'table' as const })),
    );
    const pickers = makePickerStubs({
      scopes: [
        {
          schemas: ['orbit_analytics', 'orbit_raw'],
          tables: ['orbit_analytics.events', 'orbit_raw.events'],
        },
      ],
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection,
        scanConnection,
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result.status).toBe('ready');
    expect(io.stderr()).toContain('Could not discover postgresql schemas');
    expect(vi.mocked(prompts.text).mock.calls.map(([options]) => options.message)).toContain(
      textInputPrompt(
        'Enter schemas for postgres-warehouse as a comma-separated list (e.g. SALES, MARKETING).',
      ),
    );
    expect(pickers.scopeCalls[0]).toMatchObject({
      schemas: ['orbit_analytics', 'orbit_raw'],
      initialSchemas: ['orbit_analytics', 'orbit_raw'],
      schemaSuggestion: { suggested: new Set(['orbit_analytics', 'orbit_raw']) },
    });
  });

  it('passes schemas and a lazy table callback to the scope picker instead of eager table discovery', async () => {
    const listSchemas = vi.fn(async () => ['analytics', 'raw']);
    const listTables = vi.fn(async (_projectDir: string, _connectionId: string, schemas?: string[]) =>
      (schemas ?? []).map((schema) => ({ catalog: null, schema, name: 'orders', kind: 'table' as const })),
    );
    const pickDatabaseScope = vi.fn(async (args: PickDatabaseScopeArgs) => {
      const lazyArgs = args as PickDatabaseScopeArgs & {
        schemas: string[];
        listTablesForSchemas: (schemas: string[]) => Promise<Array<{ catalog: string | null; schema: string; name: string; kind: 'table' }>>;
      };
      expect(lazyArgs.schemas).toEqual(['analytics', 'raw']);
      expect(args).not.toHaveProperty('discovered');
      expect(listTables).not.toHaveBeenCalled();
      const tables = await lazyArgs.listTablesForSchemas(['analytics']);
      expect(tables).toEqual([{ catalog: null, schema: 'analytics', name: 'orders', kind: 'table' }]);
      return { kind: 'selected' as const, activeSchemas: ['analytics'], enabledTables: ['analytics.orders'] };
    });

    await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', databaseDrivers: ['postgres'], skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts: makePromptAdapter({ selectValues: ['url'], textValues: ['', 'env:DATABASE_URL'] }),
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        listSchemas,
        listTables,
        pickDatabaseScope,
      },
    );

    expect(listTables).toHaveBeenCalledTimes(1);
    expect(listTables).toHaveBeenCalledWith(tempDir, 'postgres-warehouse', ['analytics']);
  });

  it('fails non-interactive setup when a scope-bearing connection has no schema configured', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({});
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['orbit_analytics', 'orbit_raw', 'public']);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection, listSchemas },
    );

    expect(result.status).toBe('failed');
    expect(listSchemas).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('--database-schema');
    expect(io.stderr()).toContain('connections.warehouse.schemas');
  });

  it('preserves existing BigQuery dataset_ids in non-interactive setup without rediscovering', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  bigquery-warehouse:',
        '    driver: bigquery',
        '    dataset_ids:',
        "      - 'sales'",
        '    credentials_json: env:BIGQUERY_CREDENTIALS_JSON',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['sales', 'stripe', 'posthog', 'linear']);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['bigquery-warehouse'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { testConnection, scanConnection, listSchemas },
    );

    expect(result.status).toBe('ready');
    expect(listSchemas).not.toHaveBeenCalled();
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'bigquery-warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['bigquery-warehouse']).toMatchObject({
      driver: 'bigquery',
      dataset_ids: ['sales'],
    });
  });

  it('preserves existing Postgres schemas in non-interactive setup without rediscovering', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        "      - 'analytics'",
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['analytics', 'raw', 'public']);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['warehouse'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { testConnection, scanConnection, listSchemas },
    );

    expect(result.status).toBe('ready');
    expect(listSchemas).not.toHaveBeenCalled();
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      driver: 'postgres',
      schemas: ['analytics'],
    });
  });

  it('adds one non-interactive Postgres URL connection, tests it, scans it, and marks databases complete', async () => {
    const io = makeIo();
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['orbit_analytics', 'orbit_raw', 'public']);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        skipDatabases: false,
        disableQueryHistory: true,
      },
      io.io,
      { testConnection, scanConnection, listSchemas },
    );

    expect(result.status).toBe('ready');
    expect(listSchemas).not.toHaveBeenCalled();
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toEqual({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      context: { queryHistory: { enabled: false } },
    });
    expect(config.setup).toEqual({
      database_connection_ids: ['warehouse'],
    });
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('databases');
    expect(io.stdout()).toContain('Database ready');
    expect(io.stdout()).not.toContain(['Primary source', 'ready'].join(' '));
    expect(io.stdout()).not.toContain('DATABASE_URL=');
  });

  it('adds one non-interactive SQLite connection from --database-url without prompting', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({});
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['sqlite'],
        databaseConnectionId: 'warehouse',
        databaseUrl: './warehouse.sqlite',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(prompts.text).not.toHaveBeenCalled();
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toEqual({
      driver: 'sqlite',
      path: './warehouse.sqlite',
    });
    expect(config.setup).toEqual({
      database_connection_ids: ['warehouse'],
    });
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('databases');
  });

  it('selects multiple existing connections and validates each before recording setup ids', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        "      - 'public'",
        '  analytics:',
        '    driver: snowflake',
        '    authMethod: password',
        '    account: env:SNOWFLAKE_ACCOUNT',
        '    warehouse: WH',
        '    database: ANALYTICS',
        '    schema_name: PUBLIC',
        '    username: reader',
        '    password: env:SNOWFLAKE_PASSWORD',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['warehouse', 'analytics'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(testConnection).toHaveBeenCalledTimes(2);
    expect(scanConnection).toHaveBeenCalledTimes(2);
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.database_connection_ids).toEqual(['warehouse', 'analytics']);
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('databases');
  });

  it('keeps the connection config but does not mark databases complete when scanning fails', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 1),
      },
    );

    expect(result.status).toBe('failed');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({ driver: 'postgres', url: 'env:DATABASE_URL' });
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect(io.stderr()).toContain('Database scan failed for warehouse.');
    expect(io.stderr()).toContain('│  Database scan failed for warehouse.');
    expect(io.stderr()).toContain(`Debug command: ktx ingest warehouse --project-dir ${tempDir} --debug`);
    expect(io.stderr()).not.toContain('Structural scan failed for warehouse.');
    expect(io.stderr()).not.toMatch(/^Database scan failed for warehouse\./m);
  });

  it('prints the native SQLite rebuild command when scanning hits a Node ABI mismatch', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        rebuildNativeSqlite: vi.fn(async () => 1),
        scanConnection: vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
          commandIo.stderr.write(
            [
              "The module '/workspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
              'was compiled against a different Node.js version using',
              'NODE_MODULE_VERSION 147. This version of Node.js requires',
              'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing',
              'the module (for instance, using `npm rebuild` or `npm install`).',
              '',
            ].join('\n'),
          );
          return 1;
        }),
      },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain('Native SQLite is built for a different Node.js ABI.');
    expect(io.stderr()).toContain('│  Native SQLite is built for a different Node.js ABI.');
    expect(io.stderr()).toContain('Fix: pnpm run native:rebuild');
    expect(io.stderr()).toContain(`Retry: ktx ingest warehouse --project-dir ${tempDir}`);
    expect(io.stderr()).not.toContain('ktx scan');
    expect(io.stderr()).not.toContain('npm rebuild');
    expect(io.stderr()).not.toMatch(/^Native SQLite is built for a different Node.js ABI\./m);
  });

  it('rebuilds native SQLite once and retries setup scanning after a Node ABI mismatch', async () => {
    const io = makeIo();
    const scanConnection = vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
      if (scanConnection.mock.calls.length === 1) {
        commandIo.stderr.write(
          [
            "The module '/workspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
            'was compiled against a different Node.js version using',
            'NODE_MODULE_VERSION 147. This version of Node.js requires',
            'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing',
            'the module (for instance, using `npm rebuild` or `npm install`).',
            '',
          ].join('\n'),
        );
        return 1;
      }

      commandIo.stdout.write('What changed\n');
      commandIo.stdout.write('  Semantic layer comparison found 0 changes across 56 tables\n');
      commandIo.stdout.write('  New tables: 0\n');
      commandIo.stdout.write('  Changed tables: 0\n');
      commandIo.stdout.write('  Removed tables: 0\n');
      commandIo.stdout.write('  Unchanged tables: 56\n');
      return 0;
    });
    const rebuildNativeSqlite = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection,
        rebuildNativeSqlite,
      },
    );

    expect(result.status).toBe('ready');
    expect(rebuildNativeSqlite).toHaveBeenCalledOnce();
    expect(rebuildNativeSqlite).toHaveBeenCalledWith(expect.anything());
    expect(scanConnection).toHaveBeenCalledTimes(2);
    expect(io.stderr()).toContain('Native SQLite is built for a different Node.js ABI.');
    expect(io.stderr()).toContain('Rebuilding Native SQLite with pnpm run native:rebuild…');
    expect(io.stdout()).toContain('◇  Schema context complete for warehouse');
    expect(io.stdout()).toContain('│  Changes: 0 changes across 56 tables');
  });

  function fakeHistoricSqlRunner(
    dialect: 'postgres' | 'snowflake' | 'bigquery',
    catalogName: string,
  ) {
    return {
      dialect,
      catalogName,
      async run() {
        return { warnings: [], info: [] };
      },
      formatSuccessDetail() {
        return { detail: `${catalogName} ready`, warnings: [] };
      },
      fixAdvice() {
        return {
          failHeadline: `${catalogName} unavailable`,
          remediation: 'Fix query-history grants.',
        };
      },
    };
  }

  it('writes query history config for supported Snowflake databases after validation succeeds', async () => {
    const io = makeIo();
    const runner = fakeHistoricSqlRunner(
      'snowflake',
      'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY',
    );
    const historicSqlReadinessProbe = vi.fn(async () => ({
      ok: true as const,
      dialect: 'snowflake' as const,
      runner,
      result: { warnings: [], info: [] },
    }));
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['snowflake'],
        databaseConnectionId: 'snowflake',
        databaseSchemas: ['PUBLIC'],
        enableQueryHistory: true,
        queryHistoryWindowDays: 30,
        queryHistoryServiceAccountPatterns: ['^svc_'],
        queryHistoryRedactionPatterns: ['(?i)secret'],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe,
        prompts: makePromptAdapter({
          selectValues: ['password'],
          textValues: ['env:SNOWFLAKE_ACCOUNT', 'WH', 'ANALYTICS', 'reader', ''],
          passwordValues: ['env:SNOWFLAKE_PASSWORD'],
        }),
      },
    );
    expect(historicSqlReadinessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        connectionId: 'snowflake',
        connection: expect.objectContaining({ driver: 'snowflake' }),
      }),
    );

    expect(result.status).toBe('ready');
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.connections.snowflake).toMatchObject({
      driver: 'snowflake',
      authMethod: 'password',
      context: {
        queryHistory: {
          enabled: true,
          windowDays: 30,
          filters: {
            dropTrivialProbes: true,
            serviceAccounts: {
              patterns: ['^svc_'],
              mode: 'exclude',
            },
          },
          redactionPatterns: ['(?i)secret'],
        },
      },
    });
    expect(configText).not.toContain('live-database');
    expect(configText).not.toContain('historic-sql');
    expect(configText).not.toMatch(/^\s+adapters:/m);
    expect(config.ingest.adapters).toEqual([]);
  });

  it('configures Snowflake with RSA key-pair auth via setup wizard', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['snowflake'],
        databaseConnectionId: 'snowflake',
        databaseSchemas: ['PUBLIC'],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        prompts: makePromptAdapter({
          selectValues: ['rsa'],
          textValues: [
            'env:SNOWFLAKE_ACCOUNT',
            'WH',
            'ANALYTICS',
            'reader',
            '~/.ssh/snowflake_rsa_key.p8',
            '',
          ],
          passwordValues: ['env:SNOWFLAKE_KEY_PASS'],
        }),
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.snowflake).toMatchObject({
      driver: 'snowflake',
      authMethod: 'rsa',
      account: 'env:SNOWFLAKE_ACCOUNT',
      warehouse: 'WH',
      database: 'ANALYTICS',
      username: 'reader',
      privateKey: 'file:~/.ssh/snowflake_rsa_key.p8', // pragma: allowlist secret
      passphrase: 'env:SNOWFLAKE_KEY_PASS', // pragma: allowlist secret
    });
    expect(config.connections.snowflake.password).toBeUndefined();
  });

  it('writes Postgres query history config with minExecutions and ignores window/redaction output', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableQueryHistory: true,
        queryHistoryWindowDays: 30,
        queryHistoryMinExecutions: 12,
        queryHistoryServiceAccountPatterns: ['^svc_'],
        queryHistoryRedactionPatterns: ['(?i)secret'],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe: vi.fn(async () => {
          const runner = fakeHistoricSqlRunner('postgres', 'pg_stat_statements');
          return {
            ok: true as const,
            dialect: 'postgres' as const,
            runner,
            result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
          };
        }),
      },
    );

    expect(result.status).toBe('ready');
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.connections.warehouse).toMatchObject({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      context: {
        queryHistory: {
          enabled: true,
          minExecutions: 12,
          filters: {
            dropTrivialProbes: true,
            serviceAccounts: {
              patterns: ['^svc_'],
              mode: 'exclude',
            },
          },
        },
      },
    });
    const warehouseContext =
      config.connections.warehouse.context &&
      typeof config.connections.warehouse.context === 'object' &&
      !Array.isArray(config.connections.warehouse.context)
        ? (config.connections.warehouse.context as Record<string, unknown>)
        : {};
    expect(warehouseContext.queryHistory).not.toHaveProperty('windowDays');
    expect(warehouseContext.queryHistory).not.toHaveProperty('redactionPatterns');
    expect(configText).not.toContain('live-database');
    expect(configText).not.toContain('historic-sql');
    expect(configText).not.toMatch(/^\s+adapters:/m);
    expect(config.ingest.adapters).toEqual([]);
    expect(config.ingest.workUnits.maxConcurrency).toBe(6);
    expect(io.stdout()).toContain('Query history probe...');
    expect(io.stdout()).not.toContain('Historic SQL probe...');
    expect(io.stdout()).toContain('pg_stat_statements ready');
  });

  it('auto-applies derived query-history service-account filters in non-interactive setup', async () => {
    const io = makeIo();
    const queryHistoryFilterPicker = vi.fn(async () => ({
      excludedRoles: [
        {
          role: 'svc_loader',
          pattern: '^svc_loader$',
          reason: 'Runs recurring loader traffic against modeled tables.',
        },
      ],
      consideredRoleCount: 2,
      skipped: null,
      warnings: [],
      parseFailedTemplateIds: [],
    }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe: vi.fn(async () => {
          const runner = fakeHistoricSqlRunner('postgres', 'pg_stat_statements');
          return {
            ok: true as const,
            dialect: 'postgres' as const,
            runner,
            result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
          };
        }),
        queryHistoryFilterPicker,
        createQueryHistoryLlmRuntime: vi.fn(() => null),
      },
    );

    expect(result.status).toBe('ready');
    expect(queryHistoryFilterPicker).toHaveBeenCalledTimes(1);
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      context: {
        queryHistory: {
          filters: {
            dropTrivialProbes: true,
            serviceAccounts: {
              mode: 'exclude',
              patterns: ['^svc_loader$'],
            },
          },
        },
      },
    });
    expect(io.stdout()).toContain('Proposed query-history service-account filters');
    expect(io.stdout()).toContain('svc_loader');
  });

  it('collapses query-history parse failures to a count and lists ids only with --debug', async () => {
    const io = makeIo();
    const queryHistoryFilterPicker = vi.fn(async () => ({
      excludedRoles: [],
      consideredRoleCount: 1,
      skipped: { reason: 'no-in-scope-history' as const },
      warnings: [],
      parseFailedTemplateIds: ['111', '222'],
    }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        debug: true,
        yes: true,
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe: vi.fn(async () => {
          const runner = fakeHistoricSqlRunner('postgres', 'pg_stat_statements');
          return {
            ok: true as const,
            dialect: 'postgres' as const,
            runner,
            result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
          };
        }),
        queryHistoryFilterPicker,
        createQueryHistoryLlmRuntime: vi.fn(() => null),
      },
    );

    expect(result.status).toBe('ready');
    expect(io.stdout()).toContain('Skipped 2 query templates ktx could not parse');
    expect(io.stdout()).not.toContain('111');
    expect(io.stdout()).not.toContain('222');
    expect(io.stderr()).toContain('could not parse 2 template(s): 111, 222');
  });

  it('lets interactive setup skip applying derived filters', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['skip'],
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        yes: false,
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe: vi.fn(async () => {
          const runner = fakeHistoricSqlRunner('postgres', 'pg_stat_statements');
          return {
            ok: true as const,
            dialect: 'postgres' as const,
            runner,
            result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
          };
        }),
        queryHistoryFilterPicker: vi.fn(async () => ({
          excludedRoles: [{ role: 'svc_loader', pattern: '^svc_loader$', reason: 'Loader traffic.' }],
          consideredRoleCount: 2,
          skipped: null,
          warnings: [],
          parseFailedTemplateIds: [],
        })),
        createQueryHistoryLlmRuntime: vi.fn(() => null),
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(queryHistoryFromConfig(config.connections.warehouse)?.filters).toEqual({ dropTrivialProbes: true });
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Apply 1 derived query-history service-account exclusion?',
      options: [
        { value: 'apply', label: 'Apply derived filters (recommended)' },
        { value: 'skip', label: 'Leave query history filters unchanged' },
      ],
    });
  });

  it('does not overwrite an existing serviceAccounts block', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        "      - 'public'",
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        '        filters:',
        '          dropTrivialProbes: true',
        '          serviceAccounts:',
        '            mode: exclude',
        '            patterns:',
        "              - '^existing$'",
        '',
      ].join('\n'),
      'utf-8',
    );

    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        databaseConnectionIds: ['warehouse'],
        databaseSchemas: [],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe: vi.fn(async () => {
          const runner = fakeHistoricSqlRunner('postgres', 'pg_stat_statements');
          return {
            ok: true as const,
            dialect: 'postgres' as const,
            runner,
            result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
          };
        }),
        queryHistoryFilterPicker: vi.fn(async () => ({
          excludedRoles: [{ role: 'svc_loader', pattern: '^svc_loader$', reason: 'Loader traffic.' }],
          consideredRoleCount: 2,
          skipped: { reason: 'user-block-present' as const },
          warnings: [],
          parseFailedTemplateIds: [],
        })),
        createQueryHistoryLlmRuntime: vi.fn(() => null),
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(queryHistoryFromConfig(config.connections.warehouse)?.filters?.serviceAccounts).toEqual({
      mode: 'exclude',
      patterns: ['^existing$'],
    });
    expect(io.stdout()).toContain('Existing query-history service-account filters left unchanged');
  });

  it('asks interactive Postgres setup whether to enable query history', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    readonly: true',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'scan:',
        '  enrichment:',
        '    mode: llm',
        '    embeddings:',
        '      backend: openai',
        '      model: text-embedding-3-small',
        '      dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['yes'] });
    const runner = fakeHistoricSqlRunner('postgres', 'pg_stat_statements');
    const historicSqlReadinessProbe = vi.fn(async () => ({
      ok: true as const,
      dialect: 'postgres' as const,
      runner,
      result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
    }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseConnectionIds: ['warehouse'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe,
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Enable query-history ingest for this PostgreSQL connection?',
      options: [
        { value: 'yes', label: 'Enable query history (recommended)' },
        { value: 'no', label: 'Do not enable query history' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(historicSqlReadinessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        connectionId: 'warehouse',
        connection: expect.objectContaining({ driver: 'postgres' }),
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      context: {
        queryHistory: {
          enabled: true,
          minExecutions: 5,
          filters: { dropTrivialProbes: true },
        },
      },
    });
  });

  it('writes query history config for supported existing database connections', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  analytics:',
        '    driver: bigquery',
        '    dataset_id: analytics',
        '    credentials_json: env:BIGQUERY_CREDENTIALS_JSON',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const runner = fakeHistoricSqlRunner('bigquery', 'INFORMATION_SCHEMA.JOBS_BY_PROJECT');
    const historicSqlReadinessProbe = vi.fn(async () => ({
      ok: true as const,
      dialect: 'bigquery' as const,
      runner,
      result: { warnings: [], info: [] },
    }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['analytics'],
        databaseSchemas: [],
        enableQueryHistory: true,
        queryHistoryWindowDays: 45,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe,
      },
    );

    expect(result.status).toBe('ready');
    expect(historicSqlReadinessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        connectionId: 'analytics',
        connection: expect.objectContaining({ driver: 'bigquery' }),
      }),
    );
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.connections.analytics).toMatchObject({
      context: {
        queryHistory: {
          enabled: true,
          windowDays: 45,
          filters: {
            dropTrivialProbes: true,
          },
          redactionPatterns: [],
        },
      },
    });
    expect(configText).not.toContain('live-database');
    expect(configText).not.toContain('historic-sql');
    expect(configText).not.toMatch(/^\s+adapters:/m);
    expect(config.ingest.adapters).toEqual([]);
  });

  it('prints a non-blocking BigQuery query history probe failure with the grants remediation', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  analytics:',
        '    driver: bigquery',
        '    dataset_id: analytics',
        '    credentials_json: env:BIGQUERY_CREDENTIALS_JSON',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const runner = {
      ...fakeHistoricSqlRunner('bigquery', 'INFORMATION_SCHEMA.JOBS_BY_PROJECT'),
      fixAdvice: () => ({
        failHeadline: 'BigQuery principal cannot read INFORMATION_SCHEMA.JOBS_BY_PROJECT',
        remediation:
          'Grant roles/bigquery.resourceViewer on the BigQuery project, or grant a custom role containing bigquery.jobs.listAll.',
      }),
    };
    const error = new Error('access denied');
    const historicSqlReadinessProbe = vi.fn(async () => ({
      ok: false as const,
      dialect: 'bigquery' as const,
      runner,
      error,
    }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['analytics'],
        databaseSchemas: [],
        enableQueryHistory: true,
        queryHistoryWindowDays: 45,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe,
      },
    );

    expect(result.status).toBe('ready');
    expect(historicSqlReadinessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        connectionId: 'analytics',
        connection: expect.objectContaining({ driver: 'bigquery' }),
      }),
    );
    expect(io.stdout()).toContain('Query history probe...');
    expect(io.stdout()).toContain(
      'BigQuery principal cannot read INFORMATION_SCHEMA.JOBS_BY_PROJECT',
    );
    expect(io.stdout()).toContain('roles/bigquery.resourceViewer');
    expect(io.stdout()).toContain('bigquery.jobs.listAll');
    expect(io.stdout()).toContain('Setup written; query history will be skipped until fixed.');
  });

  it('lets interactive BigQuery setup disable unavailable query history and retry after scan failure', async () => {
    const io = makeIo();
    const failurePromptOptions: KtxSetupPromptOption[][] = [];
    let failurePromptCount = 0;
    const prompts = makePromptAdapter({
      textValues: ['/tmp/service-account.json', 'US'],
    });
    vi.mocked(prompts.select).mockImplementation(async ({ message, options }) => {
      if (message.startsWith('Enable query-history ingest')) return 'yes';
      if (message.includes('How much database context should ktx build?')) return 'fast';
      if (message.startsWith('Connection setup failed for analytics')) {
        failurePromptCount += 1;
        failurePromptOptions.push(options);
        if (failurePromptCount === 1) return 'disable-query-history';
        throw new Error('setup did not disable query history before retrying');
      }
      throw new Error(`unexpected select prompt: ${message}`);
    });
    const runner = {
      ...fakeHistoricSqlRunner('bigquery', 'INFORMATION_SCHEMA.JOBS_BY_PROJECT'),
      fixAdvice: () => ({
        failHeadline: 'BigQuery principal cannot read INFORMATION_SCHEMA.JOBS_BY_PROJECT',
        remediation:
          'Grant roles/bigquery.resourceViewer on the BigQuery project, or grant a custom role containing bigquery.jobs.listAll.',
      }),
    };
    const historicSqlReadinessProbe = vi.fn(async () => ({
      ok: false as const,
      dialect: 'bigquery' as const,
      runner,
      error: new Error('access denied'),
    }));
    let scanAttempts = 0;
    const scanConnection = vi.fn(async () => {
      scanAttempts += 1;
      return scanAttempts === 1 ? 1 : 0;
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['bigquery'],
        databaseConnectionId: 'analytics',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection,
        historicSqlReadinessProbe,
        listSchemas: vi.fn(async () => ['analytics']),
        listTables: vi.fn(async () => [{ catalog: null, schema: 'analytics', name: 'orders', kind: 'table' as const }]),
      },
    );

    expect(result.status).toBe('ready');
    expect(scanConnection).toHaveBeenCalledTimes(2);
    expect(historicSqlReadinessProbe).toHaveBeenCalledTimes(1);
    expect(failurePromptOptions[0]).toContainEqual({
      value: 'disable-query-history',
      label: 'Disable query history and retry',
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.analytics).toMatchObject({
      context: {
        queryHistory: {
          enabled: false,
        },
      },
    });
  });

  it('enables query history on an existing Postgres connection', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        "      - 'public'",
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['warehouse'],
        databaseSchemas: [],
        enableQueryHistory: true,
        queryHistoryMinExecutions: 8,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe: vi.fn(async () => {
          const runner = fakeHistoricSqlRunner('postgres', 'pg_stat_statements');
          return {
            ok: true as const,
            dialect: 'postgres' as const,
            runner,
            result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
          };
        }),
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      context: {
        queryHistory: {
          enabled: true,
          minExecutions: 8,
          filters: {
            dropTrivialProbes: true,
          },
        },
      },
    });
    expect(config.connections.warehouse.historicSql).toBeUndefined();
  });

  it('prints a non-blocking Postgres query history probe failure after connection test succeeds', async () => {
    const io = makeIo();
    const runner = {
      ...fakeHistoricSqlRunner('postgres', 'pg_stat_statements'),
      fixAdvice: () => ({
        failHeadline: 'pg_stat_statements extension is not installed in the connection database',
        remediation: 'Run (against this database): CREATE EXTENSION pg_stat_statements;',
      }),
    };
    const historicSqlReadinessProbe = vi.fn(async () => ({
      ok: false as const,
      dialect: 'postgres' as const,
      runner,
      error: new Error('missing extension'),
    }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe,
      },
    );

    expect(result.status).toBe('ready');
    expect(historicSqlReadinessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        connectionId: 'warehouse',
        connection: expect.objectContaining({ driver: 'postgres' }),
      }),
    );
    expect(io.stdout()).toContain('Query history probe...');
    expect(io.stdout()).not.toContain('Historic SQL probe...');
    expect(io.stdout()).toContain('pg_stat_statements extension is not installed');
    expect(io.stdout()).toContain('Setup written; query history will be skipped until fixed.');
  });

  it('prints a non-blocking Snowflake query history probe failure with the grants remediation', async () => {
    const io = makeIo();
    const runner = {
      ...fakeHistoricSqlRunner('snowflake', 'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY'),
      fixAdvice: () => ({
        failHeadline: 'Snowflake role cannot read SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY',
        remediation:
          'Run (as ACCOUNTADMIN): GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE <connection role>;',
      }),
    };
    const historicSqlReadinessProbe = vi.fn(async () => ({
      ok: false as const,
      dialect: 'snowflake' as const,
      runner,
      error: new Error('role cannot read SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY'),
    }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['snowflake'],
        databaseConnectionId: 'warehouse',
        databaseSchemas: ['PUBLIC'],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe,
        prompts: makePromptAdapter({
          textValues: ['env:SNOWFLAKE_ACCOUNT', 'WH', 'ANALYTICS', 'reader', ''],
          passwordValues: ['env:SNOWFLAKE_PASSWORD'],
        }),
      },
    );

    expect(result.status).toBe('ready');
    expect(historicSqlReadinessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        connectionId: 'warehouse',
        connection: expect.objectContaining({ driver: 'snowflake' }),
      }),
    );
    expect(io.stdout()).toContain('Query history probe...');
    expect(io.stdout()).toContain('Snowflake role cannot read SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
    expect(io.stdout()).toContain('GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE');
    expect(io.stdout()).toContain('Setup written; query history will be skipped until fixed.');
  });

  it('does not run the query history probe when the regular connection test fails', async () => {
    const io = makeIo();
    const historicSqlReadinessProbe = vi.fn(async () => {
      const runner = fakeHistoricSqlRunner('postgres', 'pg_stat_statements');
      return {
        ok: true as const,
        dialect: 'postgres' as const,
        runner,
        result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
      };
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: [],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 1),
        scanConnection: vi.fn(async () => 0),
        historicSqlReadinessProbe,
      },
    );

    expect(result.status).toBe('failed');
    expect(historicSqlReadinessProbe).not.toHaveBeenCalled();
  });

  it('returns missing input when non-interactive database flags are incomplete', async () => {
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
    );

    expect(result.status).toBe('missing-input');
    expect(io.stderr()).toContain('Missing database connection id');
  });

  it('returns missing input when a non-interactive new connection is missing required details', async () => {
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
    );

    expect(result.status).toBe('missing-input');
    expect(io.stderr()).toContain('Missing connection details');
  });

  it('accepts former ingest subcommand names as non-interactive database connection ids', async () => {
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'replay',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.replay).toMatchObject({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    });
  });

  it('leaves setup incomplete when databases are skipped', async () => {
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'disabled', databaseSchemas: [], skipDatabases: true },
      io.io,
    );

    expect(result.status).toBe('skipped');
    expect(io.stdout()).toContain('ktx cannot work until you add a database.');
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
  });

  it('adds one non-interactive DuckDB connection from --database-url without prompting', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({});
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['duckdb'],
        databaseConnectionId: 'duckdb-local',
        databaseUrl: './warehouse.duckdb',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(prompts.text).not.toHaveBeenCalled();
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'duckdb-local', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'duckdb-local', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['duckdb-local']).toEqual({
      driver: 'duckdb',
      path: './warehouse.duckdb',
    });
    expect(config.setup).toEqual({
      database_connection_ids: ['duckdb-local'],
    });
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('databases');
  });

  it('adds an interactive DuckDB connection without prompting for a schema', async () => {
    const prompts = makePromptAdapter({
      selectValues: ['no'],
      textValues: ['', './warehouse.duckdb'],
    });
    const pickers = makePickerStubs();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['duckdb'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      makeIo().io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result.status).toBe('ready');
    expect(pickers.scopeCalls).toHaveLength(0);
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['duckdb-local']).toEqual({
      driver: 'duckdb',
      path: './warehouse.duckdb',
    });
  });
});
