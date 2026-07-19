import { type Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import { type KtxCliCommandContext, resolveCommandProjectDir } from '../cli-program.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/mongo-query-commands');

const DEFAULT_LIMIT = 1000;
const LIMIT_CAP = 10_000;

/** @internal exported only for unit testing */
export function parseLimitOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > LIMIT_CAP) {
    throw new InvalidArgumentError(`must be an integer between 1 and ${LIMIT_CAP}`);
  }
  return parsed;
}

/** @internal exported only for unit testing */
export function parsePipelineArgument(raw: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidArgumentError('must be a JSON aggregation pipeline array, e.g. \'[{"$match":{"city":"NY"}}]\'');
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((stage) => typeof stage === 'object' && stage !== null && !Array.isArray(stage))
  ) {
    throw new InvalidArgumentError('must be a JSON array of pipeline-stage objects');
  }
  return parsed as Record<string, unknown>[];
}

export function registerMongoQueryCommands(program: Command, context: KtxCliCommandContext): void {
  program
    .command('mongo-query')
    .description('Fetch rows from a MongoDB connection by running an aggregation pipeline')
    .argument('<pipeline>', 'MongoDB aggregation pipeline as a JSON array, e.g. \'[{"$match":{"city":"NY"}}]\'', parsePipelineArgument)
    .requiredOption('-c, --connection <id>', 'ktx connection id')
    .requiredOption('--collection <name>', 'Collection to query')
    .option('--database <name>', "Database name (defaults to the connection's first configured database)")
    .option('--limit <n>', 'Maximum documents to return', parseLimitOption, DEFAULT_LIMIT)
    .addOption(
      new Option('--output <mode>', 'Output mode: pretty (default), plain (TSV), or json').choices([
        'pretty',
        'plain',
        'json',
      ]),
    )
    .option('--json', 'Shortcut for --output=json (overrides --output)', false)
    .action(
      async (
        pipeline: Record<string, unknown>[],
        options: {
          connection: string;
          collection: string;
          database?: string;
          limit: number;
          output?: 'pretty' | 'plain' | 'json';
          json?: boolean;
        },
        command,
      ) => {
        const runner = context.deps.mongoQuery ?? (await import('../mongo-query.js')).runKtxMongoQuery;
        context.setExitCode(
          await runner(
            {
              projectDir: resolveCommandProjectDir(command),
              connectionId: options.connection,
              collection: options.collection,
              database: options.database,
              pipeline,
              limit: options.limit,
              output: options.output,
              json: options.json === true,
              cliVersion: context.packageInfo.version,
            },
            context.io,
          ),
        );
      },
    );
}
