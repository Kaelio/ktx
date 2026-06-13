import { type Command, Option } from '@commander-js/extra-typings';
import {
  collectOption,
  type KtxCliCommandContext,
  parsePositiveIntegerOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
import type { KtxCliDeps, KtxCliIo } from '../index.js';
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
import type { KtxPublicIngestArgs } from '../public-ingest.js';
import { profileMark } from '../startup-profile.js';
import type { KtxTextIngestArgs } from '../text-ingest.js';
import { resolveConnectionSelection } from './connection-selection.js';

profileMark('module:commands/ingest-commands');

interface IngestCommandOptions {
  runTextIngest: (args: KtxTextIngestArgs, io: KtxCliIo, deps: KtxCliDeps) => Promise<number>;
}

export function registerIngestCommands(
  program: Command,
  context: KtxCliCommandContext,
  commandOptions: IngestCommandOptions,
): void {
  const ingest = program
    .command('ingest')
    .description('Build or inspect ktx context, or capture text into memory')
    .usage('[options] [connectionId]')
    .argument('[connectionId]', 'Configured connection id to ingest (omit to ingest all)')
    .option('--all', 'Ingest all configured connections', false)
    .addOption(new Option('--query-history', 'Include database query-history usage patterns').conflicts('noQueryHistory'))
    .addOption(new Option('--no-query-history', 'Skip database query-history usage patterns'))
    .option('--query-history-window-days <days>', 'Query-history lookback window for this run', parsePositiveIntegerOption)
    .option('--text <content>', 'Capture inline text into ktx memory; repeatable', collectOption, [])
    .option('--file <path>', 'Capture a text file into ktx memory; use - for stdin; repeatable', collectOption, [])
    .option(
      '--verbatim',
      'Store each --text/--file document body unchanged as a GLOBAL wiki page; the LLM derives only metadata',
      false,
    )
    .option('--connection-id <connectionId>', 'ktx connection id to tag captured text/file notes')
    .option('--user-id <id>', 'Memory user id for text/file capture attribution', 'local-cli')
    .option('--fail-fast', 'Stop after the first failed text/file item', false)
    .addOption(new Option('--plain', 'Print plain text output').conflicts(['json']))
    .addOption(new Option('--json', 'Print JSON output').conflicts(['plain']))
    .option('--yes', 'Install required managed runtime features without prompting')
    .option('--no-input', 'Disable interactive terminal input')
    .showHelpAfterError();

  ingest.action(async (connectionId: string | undefined, options, command) => {
    const projectDir = resolveCommandProjectDir(command);
    const hasTextCapture = options.text.length > 0 || options.file.length > 0;

    if (options.verbatim === true && !hasTextCapture) {
      command.error('error: --verbatim requires --text or --file');
    }

    if (hasTextCapture) {
      if (connectionId !== undefined) {
        command.error(
          'error: --text/--file does not accept a positional connection id; use --connection-id <id> to tag captured notes',
        );
      }
      if (options.all === true) {
        command.error('error: --all cannot be combined with --text or --file');
      }
      context.setExitCode(
        await commandOptions.runTextIngest(
          {
            projectDir,
            texts: options.text,
            files: options.file,
            ...(options.connectionId ? { connectionId: options.connectionId } : {}),
            userId: options.userId,
            json: options.json === true,
            failFast: options.failFast === true,
            ...(options.verbatim === true ? { verbatim: true } : {}),
          },
          context.io,
          context.deps,
        ),
      );
      return;
    }

    const selection = resolveConnectionSelection({ connectionId, all: options.all === true });
    const { runKtxPublicIngest } = await import('../public-ingest.js');
    const queryHistory =
      options.queryHistory === true ? 'enabled' : options.queryHistory === false ? 'disabled' : 'default';
    const args: KtxPublicIngestArgs = {
      command: 'run',
      projectDir,
      ...(selection.kind === 'single' ? { targetConnectionId: selection.connectionId } : {}),
      all: selection.kind === 'all',
      json: options.json === true,
      inputMode: options.input === false ? 'disabled' : 'auto',
      queryHistory,
      ...(options.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: options.queryHistoryWindowDays } : {}),
      cliVersion: context.packageInfo.version,
      runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
    };
    context.setExitCode(await (context.deps.publicIngest ?? runKtxPublicIngest)(args, context.io));
  });

  ingest.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.('ingest', actionCommand);
  });
}
