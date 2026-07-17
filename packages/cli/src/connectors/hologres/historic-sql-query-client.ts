import type { KtxPostgresQueryClient } from '../../context/ingest/adapters/historic-sql/types.js';
import type { KtxPostgresScanConnectorOptions } from '../postgres/connector.js';
import { KtxHologresScanConnector } from './connector.js';

export type KtxHologresHistoricSqlQueryClientOptions = KtxPostgresScanConnectorOptions;

export class KtxHologresHistoricSqlQueryClient implements KtxPostgresQueryClient {
  private readonly connectionId: string;
  private readonly connector: KtxHologresScanConnector;

  constructor(options: KtxHologresHistoricSqlQueryClientOptions) {
    this.connectionId = options.connectionId;
    this.connector = new KtxHologresScanConnector(options);
  }

  async executeQuery(
    sql: string,
    params?: unknown[],
  ): Promise<{ headers: string[]; rows: unknown[][]; totalRows: number }> {
    const result = await this.connector.executeReadOnly(
      {
        connectionId: this.connectionId,
        sql,
        params,
      },
      {} as never,
    );
    return {
      headers: result.headers,
      rows: result.rows,
      totalRows: result.totalRows,
    };
  }

  async cleanup(): Promise<void> {
    await this.connector.cleanup();
  }
}
