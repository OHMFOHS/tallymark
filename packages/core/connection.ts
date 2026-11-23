import {
  Client,
  StreamableHTTPClientTransport,
  SdkError,
  SdkErrorCode,
  type JsonSchemaType,
} from '@modelcontextprotocol/client';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BoundedSchemaValidator } from './schema-validation.js';
import { version } from '../contracts/version.js';
import { attemptMetaKey } from '../contracts/attempt.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  endpoint,
  PublicError,
  type Case,
  type Target,
  type ResponseKind,
} from '../contracts/index.js';

export interface Permissions {
  allowExternal: boolean;
  allowStdio?: boolean;
  allowedUrls: string[];
}
export function requirePermission(target: Target, permissions: Permissions) {
  if (target.kind === 'fixture') return;
  if (!permissions.allowExternal)
    throw new PublicError('External targets require --allow-external.');
  if (target.kind === 'stdio' && !permissions.allowStdio)
    throw new PublicError('External executable requires --allow-stdio.');
  if (
    target.kind === 'http' &&
    !permissions.allowedUrls.map(endpoint).includes(endpoint(target.url))
  )
    throw new PublicError(
      'Network target requires an exact --allow-url match.',
    );
}

const byteLimit = 1024 * 1024;
function httpTransport(url: string, signal: AbortSignal) {
  const allowed = endpoint(url);
  return new StreamableHTTPClientTransport(new URL(allowed), {
    requestInit: { redirect: 'error' },
    maxStepUpRetries: 0,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      const address = input instanceof Request ? input.url : String(input);
      if (endpoint(address) !== allowed)
        throw new PublicError('SDK requested an unlisted endpoint.');
      const requestSignal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signals = [signal];
      if (requestSignal) signals.push(requestSignal);
      if (init?.method === 'DELETE') signals.push(AbortSignal.timeout(1000));
      const response = await fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any(signals),
      });
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > byteLimit)
              throw new Error('HTTP response exceeded limit.');
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
}

export async function openConnection(
  target: Target,
  dir: string,
  permissions: Permissions,
  signal: AbortSignal,
  timeout: number,
  fault?: Case['fault'],
) {
  requirePermission(target, permissions);
  signal.throwIfAborted();
  const temp =
    target.kind === 'fixture'
      ? await mkdtemp(join(tmpdir(), 'mcp-reliability-'))
      : undefined;
  const ledger = temp && join(temp, 'ledger.json');
  const validator =
    target.kind === 'fixture'
      ? new CfWorkerJsonSchemaValidator()
      : new BoundedSchemaValidator();
  const client = new Client(
    { name: 'mcp-reliability-kit', version },
    {
      versionNegotiation: { mode: 'auto', probe: { maxRetries: 0 } },
      inputRequired: { autoFulfill: false },
      listMaxPages: 8,
      jsonSchemaValidator: validator,
    },
  );
  let http: StreamableHTTPClientTransport | undefined;
  const close = async () => {
    try {
      try {
        if (http?.sessionId) await http.terminateSession();
      } finally {
        await client.close();
      }
    } finally {
      if (temp) await rm(temp, { force: true, recursive: true, maxRetries: 2 });
    }
  };
  try {
    const transport =
      target.kind === 'http'
        ? httpTransport(target.url, signal)
        : new StdioClientTransport({
            command:
              target.kind === 'fixture' ? process.execPath : target.command,
            args:
              target.kind === 'fixture'
                ? [
                    fileURLToPath(
                      new URL('../fixtures/main.js', import.meta.url),
                    ),
                    target.mode,
                    ledger!,
                    String(fault?.kind === 'transient' ? fault.failures : 0),
                    fault?.kind === 'timeout' ? 'yes' : 'no',
                  ]
                : target.args,
            cwd: dir,
            stderr: 'ignore',
            maxBufferSize: byteLimit,
          });
    if (transport instanceof StreamableHTTPClientTransport) http = transport;
    await client.connect(transport, { timeout, signal });
    const protocol = client.getNegotiatedProtocolVersion();
    if (!protocol || !/^\d{4}-\d{2}-\d{2}$/.test(protocol))
      throw new PublicError('Protocol version negotiation failed.');
    const { tools } = await client.listTools({}, { timeout, signal });
    if (tools.length > 512)
      throw new PublicError('Tool discovery exceeded 512 entries.');
    return {
      ledger,
      protocol,
      tools: tools.map((t) => t.name),
      inventory: tools.map((t) => ({
        name: /^[\w.-]{1,128}$/.test(t.name)
          ? t.name
          : '[unsupported tool name]',
        readOnlyHint: t.annotations?.readOnlyHint ?? null,
        taskRequired: t.execution?.taskSupport === 'required',
      })),
      close,
      checkTool(
        name: string,
        args: Record<string, unknown>,
      ): 'missing' | 'taskRequired' | 'arguments' | null {
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) return 'missing';
        if (tool.execution?.taskSupport === 'required') return 'taskRequired';
        try {
          const validation = validator.getValidator(
            tool.inputSchema as JsonSchemaType,
          )(args);
          return validation.valid ? null : 'arguments';
        } catch {
          return 'arguments';
        }
      },
      async invoke(
        tool: string,
        args: Record<string, unknown>,
        ms: number,
        id?: string,
      ): Promise<ResponseKind | 'unknown'> {
        try {
          const reply = await client.callTool(
            {
              name: tool,
              arguments: args,
              ...(id ? { _meta: { [attemptMetaKey]: id } } : {}),
            },
            {
              timeout: ms,
              maxTotalTimeout: ms,
              signal,
              // Pin the definition we admitted. The SDK otherwise refreshes and
              // resends a tools/call after an HTTP header-mismatch response.
              toolDefinition: tools.find(
                (candidate) => candidate.name === tool,
              ),
            },
          );
          return reply.isError ? 'tool-error' : 'success';
        } catch (error) {
          signal.throwIfAborted();
          if (
            error instanceof SdkError &&
            error.code === SdkErrorCode.RequestTimeout
          )
            return 'timeout';
          return 'unknown';
        }
      },
    };
  } catch (error) {
    await close();
    if (error instanceof PublicError) throw error;
    throw new PublicError(
      'MCP discovery failed. For HTTP check the exact Streamable HTTP endpoint and start the server. For stdio check the executable, arguments and working directory.',
    );
  }
}
