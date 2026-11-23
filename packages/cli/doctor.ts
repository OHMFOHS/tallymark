import { dirname, resolve } from 'node:path';
import {
  endpoint,
  PublicError,
  readBounded,
  targetSchema,
  type Target,
} from '../contracts/index.js';
import { openConnection } from '../core/connection.js';

interface DoctorOptions {
  url?: string;
  allowUrl?: string;
  stdioConfig?: string;
  allowStdio?: boolean;
  json?: boolean;
}

export function discoveryUrl(value: string) {
  const url = new URL(endpoint(value));
  if (!isLoopback(url) && url.protocol !== 'https:')
    throw new PublicError(
      'Use HTTPS for remote discovery, or run the server on loopback.',
    );
  return url;
}
function isLoopback(url: URL) {
  return ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
}

export async function doctor(opts: DoctorOptions, signal: AbortSignal) {
  if (opts.url === '' || opts.stdioConfig === '')
    throw new PublicError(
      'Provide a nonempty endpoint URL or stdio target file.',
    );
  if (opts.url && opts.stdioConfig)
    throw new PublicError('Choose one target: --url or --stdio-config.');
  if ((opts.allowUrl && !opts.url) || (opts.allowStdio && !opts.stdioConfig))
    throw new PublicError(
      'Pair --allow-url with --url, or --allow-stdio with --stdio-config.',
    );
  let target: Target = { kind: 'fixture', mode: 'safe' };
  let directory = process.cwd();
  if (opts.url) {
    const url = discoveryUrl(opts.url);
    if (
      (!isLoopback(url) || opts.allowUrl) &&
      (!opts.allowUrl || endpoint(opts.allowUrl) !== url.href)
    )
      throw new PublicError(
        'Authorize the exact remote HTTPS endpoint using --allow-url with the same URL.',
      );
    target = { kind: 'http', url: url.href };
  }
  if (opts.stdioConfig) {
    if (!opts.allowStdio)
      throw new PublicError(
        'Review the local executable and arguments, then add --allow-stdio to launch it for discovery.',
      );
    try {
      const parsed = targetSchema.parse(
        JSON.parse(await readBounded(opts.stdioConfig, 65536)),
      );
      if (parsed.kind !== 'stdio') throw new Error();
      target = parsed;
      directory = dirname(resolve(opts.stdioConfig));
    } catch {
      throw new PublicError(
        'Invalid stdio target file. Supply a readable JSON file with kind "stdio", command and an optional string array args (64 KiB maximum).',
      );
    }
  }
  const conn = await openConnection(
    target,
    directory,
    {
      allowExternal: true,
      allowStdio: !!opts.allowStdio,
      allowedUrls: target.kind === 'http' ? [target.url] : [],
    },
    signal,
    3000,
  );
  try {
    const result = {
      diagnosticVersion: 1,
      mode: 'observational',
      transport: target.kind,
      protocol: conn.protocol,
      toolCalls: 0,
      safety: 'unassessed',
      tools: conn.inventory,
      nextSteps: [
        target.kind === 'http'
          ? 'Create a disabled observation with mcp-reliability-kit init --url <endpoint> --tool <name>. Review the arguments and authorize the case before running it.'
          : 'To observe a tool, initialize a suite, set its target, tool and arguments, and review allowSideEffects. Use mode: observational and verify.kind: none.',
        'To verify a state change, declare the effect bound and export committed effects and terminal attempt IDs from the downstream store. Set mode: verified and verify.kind: file.',
      ],
    };
    if (opts.json) return console.log(JSON.stringify(result, null, 2));
    console.log(
      [
        `Connected (${result.transport}, MCP ${result.protocol}). Discovered ${result.tools.length} ${result.tools.length === 1 ? 'tool' : 'tools'}. Tool calls: 0.`,
        ...result.tools.map(
          (t) =>
            `  ${t.name}  [${t.readOnlyHint === true ? 'advertised read-only' : t.readOnlyHint === false ? 'may write' : 'read-only hint absent'}${t.taskRequired ? ', task required' : ''}]`,
        ),
        'Execution safety: unassessed. Discovery checks connectivity and tool metadata. Server hints do not establish backend behavior.',
        ...result.nextSteps,
      ].join('\n'),
    );
  } finally {
    await conn.close();
  }
}
