import { HistoricSqlGrantsMissingError } from '../adapters/historic-sql/errors.js';
import { BigQueryHistoricSqlQueryHistoryReader } from '../adapters/historic-sql/bigquery-query-history-reader.js';
import {
  type HistoricSqlFixAdvice,
  type HistoricSqlProbeInput,
  type HistoricSqlProbeRunner,
  type HistoricSqlSuccessDetail,
} from '../historic-sql-probes.js';
import {
  bigQueryConnectionConfigFromConfig,
  isKtxBigQueryConnectionConfig,
  KtxBigQueryScanConnector,
  type KtxBigQueryConnectionConfig,
} from '../../../connectors/bigquery/connector.js';

interface GenericProbeResult {
  warnings: string[];
  info?: string[];
}

interface ClientHandle {
  client: unknown;
  cleanup(): Promise<void>;
}

interface BigQueryJobsByProjectProbeRunnerOptions {
  createReader?: (options: { projectId: string; region: string }) => {
    probe(client: unknown): Promise<GenericProbeResult>;
  };
  createClient?: (
    input: HistoricSqlProbeInput & { connection: KtxBigQueryConnectionConfig },
  ) => ClientHandle;
}

function bigQueryRegion(connection: KtxBigQueryConnectionConfig): string {
  return typeof connection.location === 'string' && connection.location.trim().length > 0
    ? connection.location.trim()
    : 'us';
}

function infoSuffix(info: readonly string[] | undefined): string {
  return info && info.length > 0 ? `; ${info.join('; ')}` : '';
}

export class BigQueryJobsByProjectProbeRunner implements HistoricSqlProbeRunner {
  readonly dialect = 'bigquery' as const;
  readonly catalogName = 'INFORMATION_SCHEMA.JOBS_BY_PROJECT';

  private readonly createReader: (options: { projectId: string; region: string }) => {
    probe(client: unknown): Promise<GenericProbeResult>;
  };
  private readonly createClient: (
    input: HistoricSqlProbeInput & { connection: KtxBigQueryConnectionConfig },
  ) => ClientHandle;
  constructor(options: BigQueryJobsByProjectProbeRunnerOptions = {}) {
    this.createReader =
      options.createReader ??
      ((readerOptions) => new BigQueryHistoricSqlQueryHistoryReader(readerOptions));
    this.createClient =
      options.createClient ??
      ((input) => {
        const connector = new KtxBigQueryScanConnector({
          connectionId: input.connectionId,
          connection: input.connection,
          env: input.env,
        });
        return {
          client: {
            async executeQuery(sql: string) {
              const result = await connector.executeReadOnly(
                { connectionId: input.connectionId, sql },
                {} as never,
              );
              return {
                headers: result.headers,
                rows: result.rows,
                totalRows: result.totalRows,
              };
            },
          },
          cleanup: () => connector.cleanup(),
        };
      });
  }

  async run(input: HistoricSqlProbeInput): Promise<GenericProbeResult> {
    const inputDriver = input.connection.driver ?? 'unknown';
    if (!isKtxBigQueryConnectionConfig(input.connection)) {
      throw new Error(`Native BigQuery connector cannot run driver "${inputDriver}"`);
    }
    const projectId = bigQueryConnectionConfigFromConfig({
      connectionId: input.connectionId,
      connection: input.connection,
      env: input.env,
    }).projectId;
    const reader = this.createReader({
      projectId,
      region: bigQueryRegion(input.connection),
    });
    const handle = this.createClient({
      ...input,
      connection: input.connection,
    });
    try {
      return await reader.probe(handle.client);
    } finally {
      await handle.cleanup();
    }
  }

  formatSuccessDetail(result: unknown): HistoricSqlSuccessDetail {
    const probeResult = result as GenericProbeResult;
    return {
      detail: `${this.catalogName} ready${infoSuffix(probeResult.info)}`,
      warnings: probeResult.warnings,
    };
  }

  fixAdvice(error: unknown): HistoricSqlFixAdvice {
    if (error instanceof HistoricSqlGrantsMissingError) {
      return {
        failHeadline: 'BigQuery principal cannot read INFORMATION_SCHEMA.JOBS_BY_PROJECT',
        remediation: error.remediation,
      };
    }
    return {
      failHeadline: `${this.catalogName} readiness check failed`,
      remediation: error instanceof Error ? error.message : String(error),
    };
  }
}
