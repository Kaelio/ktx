import type { KtxMongoDbScanConnector, KtxMongoQueryResult } from '../../connectors/mongodb/connector.js';
import { KtxExpectedError } from '../../errors.js';
import { assertSafeConnectionId } from '../sl/source-files.js';
import type { KtxScanConnector } from '../scan/types.js';

export interface KtxMongoQueryRequest {
  connectionId: string;
  collection: string;
  database?: string;
  pipeline: Record<string, unknown>[];
  limit: number;
}

/** Single Mongo-read execution seam: resolve the connector, guard the driver, run the pipeline. */
export async function runMongoQuery(
  createConnector: (connectionId: string) => Promise<KtxScanConnector> | KtxScanConnector,
  input: KtxMongoQueryRequest,
): Promise<KtxMongoQueryResult> {
  const connectionId = assertSafeConnectionId(input.connectionId);
  let connector: KtxScanConnector | null = null;
  try {
    connector = await createConnector(connectionId);
    if (connector.driver !== 'mongodb') {
      throw new KtxExpectedError(
        `Connection "${connectionId}" driver "${connector.driver}" is not a MongoDB connection; mongo_query serves mongodb connections only.`,
      );
    }
    return await (connector as unknown as KtxMongoDbScanConnector).executeQuery(
      { connectionId, collection: input.collection, database: input.database, pipeline: input.pipeline, limit: input.limit },
      { runId: 'mongo-query' },
    );
  } finally {
    await connector?.cleanup?.();
  }
}
