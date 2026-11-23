import { readFile, writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { identifier, parseSuite, PublicError } from '../contracts/index.js';
import { discoveryUrl } from './doctor.js';

export async function init(opts: {
  config: string;
  fixture?: string;
  example?: string;
  url?: string;
  tool?: string;
}) {
  let yaml: string;
  let message: string;
  if (opts.url !== undefined || opts.tool !== undefined) {
    if (
      !opts.url ||
      !identifier.safeParse(opts.tool).success ||
      opts.example !== undefined ||
      opts.fixture !== undefined
    )
      throw new PublicError(
        'Provide --url and a valid --tool together. Use --example and --fixture separately for bundled examples.',
      );
    yaml =
      '# Review the arguments and the effect bound before enabling this case.\n' +
      stringify({
        version: 1,
        targets: {
          service: { kind: 'http', url: discoveryUrl(opts.url).href },
        },
        tests: [
          {
            id: 'observe-tool',
            target: 'service',
            mode: 'observational',
            tool: opts.tool,
            arguments: {},
            allowSideEffects: false,
            fault: { kind: 'none' },
            expectResponses: ['success'],
            verify: { kind: 'none' },
            invariant: { minEffects: 0, maxEffects: 0 },
          },
        ],
      });
    message =
      'Created a disabled HTTP observation. Review the arguments, then enable allowSideEffects and run test with --allow-external and the exact --allow-url.';
  } else {
    const fixture = opts.fixture ?? 'safe';
    const example = opts.example ?? 'fixture';
    if (!['safe', 'unsafe'].includes(fixture))
      throw new PublicError('Choose safe or unsafe for --fixture.');
    if (
      !['fixture', 'filesystem'].includes(example) ||
      (example === 'filesystem' && fixture !== 'safe')
    )
      throw new PublicError(
        'Choose --example fixture or filesystem. --fixture unsafe applies only to the fixture example.',
      );
    const template =
      example === 'fixture' ? 'reliability.yaml' : 'observe-filesystem.yaml';
    yaml = (
      await readFile(
        new URL('../../../examples/' + template, import.meta.url),
        'utf8',
      )
    ).replace('mode: safe', 'mode: ' + fixture);
    message =
      example === 'fixture'
        ? 'Created fixture contract.'
        : 'Created read-only Filesystem observation. Install mcp-server-filesystem on PATH, then run list and test with --allow-external --allow-stdio.';
  }
  parseSuite(yaml);
  try {
    await writeFile(opts.config, yaml, { flag: 'wx', mode: 0o600 });
  } catch {
    throw new PublicError(
      'Cannot create configuration. Choose a new path in a writable directory.',
    );
  }
  console.log(message);
}
