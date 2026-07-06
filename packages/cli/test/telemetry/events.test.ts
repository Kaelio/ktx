import { describe, expect, it } from 'vitest';

import {
  buildTelemetryEvent,
  telemetryEventCatalog,
  telemetryEventSchemas,
  type TelemetryCommonEnvelope,
} from '../../src/telemetry/events.js';

const envelope: TelemetryCommonEnvelope = {
  cliVersion: '0.4.1',
  nodeVersion: 'v22.0.0',
  osPlatform: 'darwin',
  osRelease: '25.0.0',
  arch: 'arm64',
  runtime: 'node',
  isCi: false,
};

describe('telemetry event schemas', () => {
  it('catalogs all v1 telemetry events', () => {
    expect(telemetryEventCatalog.map((event) => event.name)).toEqual([
      'install_first_run',
      'command',
      'setup_step',
      'connection_added',
      'connection_test',
      'project_stack_snapshot',
      'ingest_completed',
      'scan_completed',
      'sl_validate_completed',
      'sl_query_completed',
      'sql_completed',
      'mongo_query_completed',
      'wiki_query_completed',
      'mcp_request_completed',
      'daemon_started',
      'daemon_stopped',
      'sl_plan_completed',
      'sql_gen_completed',
      'query_history_filter_completed',
    ]);
  });

  it('builds strict daemon telemetry events', () => {
    const daemonEnvelope = {
      ...envelope,
      runtime: 'daemon-py' as const,
      nodeVersion: '3.13.0',
    };

    expect(
      buildTelemetryEvent('sl_plan_completed', daemonEnvelope, {
        outcome: 'ok',
        stage: 'transpile',
        durationMs: 25,
        sourceCount: 2,
        joinCount: 1,
      }),
    ).toMatchObject({
      name: 'sl_plan_completed',
      properties: {
        runtime: 'daemon-py',
        outcome: 'ok',
        stage: 'transpile',
        sourceCount: 2,
        joinCount: 1,
      },
    });

    expect(() =>
      telemetryEventSchemas.sql_gen_completed.parse({
        ...daemonEnvelope,
        outcome: 'ok',
        dialect: 'postgres',
        durationMs: 4,
        sql: 'select * from private_table',
      }),
    ).toThrow();
  });

  it('builds a strict install_first_run event', () => {
    expect(buildTelemetryEvent('install_first_run', envelope, {})).toEqual({
      name: 'install_first_run',
      properties: envelope,
    });
  });

  it('builds a strict command event with project grouping fields', () => {
    expect(
      buildTelemetryEvent('command', envelope, {
        commandPath: ['ktx', 'status'],
        durationMs: 12,
        outcome: 'ok',
        flagsPresent: { json: true },
        hasProject: true,
        projectGroupAttached: true,
      }),
    ).toEqual({
      name: 'command',
      properties: {
        ...envelope,
        commandPath: ['ktx', 'status'],
        durationMs: 12,
        outcome: 'ok',
        flagsPresent: { json: true },
        hasProject: true,
        projectGroupAttached: true,
      },
    });
  });

  it('rejects unmodeled event properties', () => {
    expect(() =>
      telemetryEventSchemas.command.parse({
        ...envelope,
        commandPath: ['ktx', 'status'],
        durationMs: 12,
        outcome: 'ok',
        flagsPresent: {},
        hasProject: true,
        projectGroupAttached: true,
        tableName: 'private_table',
      }),
    ).toThrow();
  });

  it('builds strict Phase 2 events without private names or text', () => {
    expect(
      buildTelemetryEvent('connection_test', envelope, {
        driver: 'postgres',
        isDemoConnection: false,
        outcome: 'ok',
        durationMs: 34,
        serverVersion: '16',
      }),
    ).toMatchObject({
      name: 'connection_test',
      properties: {
        driver: 'postgres',
        isDemoConnection: false,
        outcome: 'ok',
        durationMs: 34,
        serverVersion: '16',
      },
    });

    expect(() =>
      telemetryEventSchemas.sql_completed.parse({
        ...envelope,
        driver: 'postgres',
        isDemoConnection: false,
        queryVerb: 'select',
        referencedTableCount: 1,
        durationMs: 10,
        outcome: 'ok',
        sql: 'select * from private_table',
      }),
    ).toThrow();
  });

  it('rejects raw private field names that are not in the telemetry schemas', () => {
    expect(JSON.stringify(telemetryEventSchemas)).not.toContain('tableName');
    expect(Object.keys(telemetryEventSchemas.sql_completed.shape)).not.toContain('sql');
    expect(JSON.stringify(telemetryEventSchemas)).not.toContain('path');
  });
});
