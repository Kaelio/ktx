import {
  HistoricSqlExtensionMissingError,
  HistoricSqlGrantsMissingError,
} from '../adapters/historic-sql/errors.js';
import {
  HologresQueryLogReader,
  type HologresQueryLogProbeResult,
} from '../adapters/historic-sql/hologres-query-log-reader.js';
import {
  type HistoricSqlFixAdvice,
  type HistoricSqlProbeInput,
  type HistoricSqlProbeRunner,
  type HistoricSqlSuccessDetail,
} from '../historic-sql-probes.js';
import {
  isKtxHologresConnectionConfig,
  type KtxHologresConnectionConfig,
} from '../../../connectors/hologres/connector.js';
import { KtxHologresHistoricSqlQueryClient } from '../../../connectors/hologres/historic-sql-query-client.js';

interface ClientHandle {
  client: unknown;
  cleanup(): Promise<void>;
}

interface HologresQueryLogProbeRunnerOptions {
  reader?: { probe(client: unknown): Promise<HologresQueryLogProbeResult> };
  createClient?: (
    input: HistoricSqlProbeInput & { connection: KtxHologresConnectionConfig },
  ) => ClientHandle;
}

export class HologresQueryLogProbeRunner implements HistoricSqlProbeRunner {
  readonly dialect = 'hologres' as const;
  readonly catalogName = 'hologres.hg_query_log';

  private readonly reader: { probe(client: unknown): Promise<HologresQueryLogProbeResult> };
  private readonly createClient: (
    input: HistoricSqlProbeInput & { connection: KtxHologresConnectionConfig },
  ) => ClientHandle;

  constructor(options: HologresQueryLogProbeRunnerOptions = {}) {
    this.reader = options.reader ?? new HologresQueryLogReader();
    this.createClient =
      options.createClient ??
      ((input) => {
        const client = new KtxHologresHistoricSqlQueryClient({
          connectionId: input.connectionId,
          connection: input.connection,
          env: input.env,
        });
        return { client, cleanup: () => client.cleanup() };
      });
  }

  async run(input: HistoricSqlProbeInput): Promise<HologresQueryLogProbeResult> {
    const inputDriver = input.connection.driver ?? 'unknown';
    if (!isKtxHologresConnectionConfig(input.connection)) {
      throw new Error(`Hologres query-log probe requires a Hologres connection, got "${String(inputDriver)}"`);
    }
    const handle = this.createClient({ ...input, connection: input.connection });
    try {
      return await this.reader.probe(handle.client);
    } finally {
      await handle.cleanup();
    }
  }

  formatSuccessDetail(result: unknown): HistoricSqlSuccessDetail {
    const hologresResult = result as HologresQueryLogProbeResult;
    return {
      detail: 'hologres.hg_query_log ready',
      warnings: hologresResult.warnings,
    };
  }

  fixAdvice(error: unknown): HistoricSqlFixAdvice {
    if (error instanceof HistoricSqlExtensionMissingError) {
      return {
        failHeadline: 'hologres.hg_query_log is not accessible',
        remediation: error.remediation,
      };
    }
    if (error instanceof HistoricSqlGrantsMissingError) {
      return {
        failHeadline: 'Hologres connection role lacks query-log access',
        remediation: error.remediation,
      };
    }
    return {
      failHeadline: `${this.catalogName} readiness check failed`,
      remediation: error instanceof Error ? error.message : String(error),
    };
  }
}
