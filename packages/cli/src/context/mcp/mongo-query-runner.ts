import { KtxExpectedError } from '../../errors.js';
import { assertSafeConnectionId } from '../sl/source-files.js';
import type { KtxMongoQueryInput, KtxMongoQueryResult, KtxScanConnector } from '../scan/types.js';

/** Single Mongo-read execution seam: resolve the connector, guard the driver, run the pipeline. */
export async function runMongoQuery(
  createConnector: (connectionId: string) => Promise<KtxScanConnector> | KtxScanConnector,
  input: KtxMongoQueryInput,
): Promise<KtxMongoQueryResult> {
  const connectionId = assertSafeConnectionId(input.connectionId);
  let connector: KtxScanConnector | null = null;
  try {
    connector = await createConnector(connectionId);
    if (connector.driver !== 'mongodb' || typeof connector.executeQuery !== 'function') {
      throw new KtxExpectedError(
        `Connection "${connectionId}" driver "${connector.driver}" is not a MongoDB connection; mongo_query serves mongodb connections only.`,
      );
    }
    return await connector.executeQuery({ ...input, connectionId }, { runId: 'mongo-query' });
  } finally {
    await connector?.cleanup?.();
  }
}
