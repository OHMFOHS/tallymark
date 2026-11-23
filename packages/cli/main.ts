#!/usr/bin/env node
import { doctor } from './doctor.js';
import { Command, CommanderError } from 'commander';
import { init } from './init.js';
import { inspectJournal } from '../reporters/journal.js';
import { version } from '../contracts/version.js';
import { dirname, join, resolve } from 'node:path';
import { parseSuite, PublicError, readBounded } from '../contracts/index.js';
import { openConnection, type Permissions } from '../core/connection.js';
import { reportSchema } from '../core/evidence.js';
import { runSuite } from '../core/runner.js';
import { exitCode, startRun, summary } from '../reporters/index.js';

interface TargetOptions {
  config: string;
  allowExternal?: boolean;
  allowStdio?: boolean;
  allowUrl?: string[];
}
const program = new Command();
program
  .name('mcp-reliability-kit')
  .version(version)
  .description(
    'Test MCP tool execution contracts against independent backend state.',
  )
  .exitOverride()
  .showHelpAfterError();
const interrupted = new AbortController();
for (const name of ['SIGTERM', 'SIGINT'] as const)
  process.once(name, () => interrupted.abort());
program
  .command('doctor')
  .description(
    'Check MCP connectivity and discover tool hints without calling any tool. Defaults to the isolated local fixture.',
  )
  .option(
    '--url <url>',
    'Streamable HTTP endpoint (loopback or explicitly authorized HTTPS)',
  )
  .option('--allow-url <url>', 'authorize the exact remote HTTPS endpoint')
  .option(
    '--stdio-config <file>',
    'local stdio target JSON with command and arguments',
  )
  .option(
    '--allow-stdio',
    'launch the reviewed executable in the stdio target file',
  )
  .option('--json', 'emit the discovery diagnostic as JSON')
  .action((opts) =>
    doctor(
      opts,
      AbortSignal.any([interrupted.signal, AbortSignal.timeout(15000)]),
    ),
  );
program
  .command('init')
  .description(
    'Create a fixture suite or a disabled HTTP observation in a new file.',
  )
  .option('-c, --config <path>', 'destination YAML', 'reliability.yaml')
  .option('--fixture <mode>', 'safe (default) or unsafe')
  .option('--example <name>', 'fixture (default) or filesystem')
  .option('--url <endpoint>', 'HTTP endpoint for an observational suite')
  .option('--tool <name>', 'tool to observe with --url')
  .action(init);
function targetOptions(cmd: Command) {
  return cmd
    .option('-c, --config <path>', 'suite YAML', 'reliability.yaml')
    .option(
      '--allow-external',
      'allow the configured external test server to start or connect',
    )
    .option(
      '--allow-stdio',
      'permit launching configured external stdio executables',
    )
    .option(
      '--allow-url <url>',
      'allow this exact network endpoint (repeatable)',
      (s: string, acc: string[]) => [...acc, s],
      [],
    );
}
function permissions(opts: TargetOptions): Permissions {
  return {
    allowExternal: !!opts.allowExternal,
    allowStdio: !!opts.allowStdio,
    allowedUrls: opts.allowUrl ?? [],
  };
}
async function config(path: string) {
  let text;
  try {
    text = await readBounded(path, 65536);
  } catch {
    throw new PublicError(
      'Cannot read configuration. Select a regular YAML file of at most 64 KiB with -c, or create one with init.',
    );
  }
  return parseSuite(text);
}

targetOptions(
  program
    .command('list')
    .description('Discover tool names without invoking a tool.'),
)
  .option('--target <id>', 'target name (required for multiple targets)')
  .action(async (opts: TargetOptions & { target?: string }) => {
    const suite = await config(opts.config);
    const names = Object.keys(suite.targets);
    const name = opts.target ?? (names.length === 1 ? names[0] : undefined);
    if (!name || !Object.hasOwn(suite.targets, name))
      throw new PublicError('Select a configured target with --target.');
    const connection = await openConnection(
      suite.targets[name]!,
      dirname(resolve(opts.config)),
      permissions(opts),
      AbortSignal.any([interrupted.signal, AbortSignal.timeout(15000)]),
      3000,
    );
    try {
      console.log(`Protocol ${connection.protocol}`);
      for (const tool of connection.tools)
        console.log(
          /^[\w.-]{1,128}$/.test(tool) ? tool : '[unsupported tool name]',
        );
    } finally {
      await connection.close();
    }
  });
targetOptions(
  program
    .command('test')
    .description('Run a suite and write JSON and JUnit evidence.'),
)
  .option('--out <directory>', 'parent of a new run directory', 'artifacts')
  .option('--case <id>', 'run only the named case from the original suite')
  .action(async (opts: TargetOptions & { out: string; case?: string }) => {
    const suite = await config(opts.config);
    if (opts.case !== undefined) {
      suite.tests = suite.tests.filter((t) => t.id === opts.case);
      if (!suite.tests.length)
        throw new PublicError(
          'Unknown case. Use a test id from the selected configuration.',
        );
    }
    const run = await startRun(
      opts.out,
      suite.seed,
      suite.tests.map((t) => t.id),
    );
    console.error('Progress journal: ' + run.path);
    const report = await runSuite(suite, {
      onBeforeInvoke: run.beforeInvoke,
      onCaseComplete: run.checkpoint,
      ...permissions(opts),
      directory: dirname(resolve(opts.config)),
      signal: interrupted.signal,
    });
    console.log(summary(report));
    const directory = await run.publish(report);
    console.log(
      `JSON report: ${join(directory, 'report.json')}\nJUnit report: ${join(directory, 'junit.xml')}`,
    );
    process.exitCode = exitCode(report);
  });
program
  .command('journal')
  .description(
    'Inspect an interrupted run offline. A valid incomplete journal exits 3.',
  )
  .argument('<file>')
  .option('--json', 'emit correlation identifiers as JSON')
  .action(async (file: string, opts: { json?: boolean }) => {
    const journal = await inspectJournal(file);
    if (opts.json) console.log(JSON.stringify(journal, null, 2));
    else {
      console.log(
        `Incomplete run (seed ${journal.seed}): ${journal.completed.length}/${journal.planned.length} completed.`,
      );
      for (const r of journal.completed)
        console.log(
          `  Completed ${r.id}: ${r.operationKey} (${r.invocationCount} calls recorded)`,
        );
      if (journal.active)
        console.log(
          `  Pending ${journal.active.caseId} / ${journal.active.tool}: ${journal.active.possibleAttempts.join(', ')}`,
        );
      console.log(journal.guidance);
    }
    process.exitCode = 3;
  });
program
  .command('report')
  .description('Summarize a saved JSON report and return its suite exit code.')
  .argument('<file>')
  .action(async (file: string) => {
    let report;
    try {
      report = reportSchema.parse(
        JSON.parse(await readBounded(file, 1024 * 1024)),
      );
    } catch {
      throw new PublicError(
        'Invalid, unreadable or unsupported JSON report. Select report.json from a completed run directory.',
      );
    }
    console.log(summary(report));
    process.exitCode = exitCode(report);
  });
try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError)
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  else {
    console.error(
      error instanceof PublicError
        ? error.message
        : 'Operation failed. Check filesystem access, target configuration and the troubleshooting guide.',
    );
    process.exitCode = 2;
  }
}
