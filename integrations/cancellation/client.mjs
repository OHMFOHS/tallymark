// Observe the real SDK transport at the socket-write boundary on Node 24+.
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Client,
  StreamableHTTPClientTransport,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHttp } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { openConnection } from '../../dist/packages/core/connection.js';

const [generation, endpoint, key, deadline, trace, finish] =
  process.argv.slice(2);
const url = new URL(endpoint);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.protocol, 'http:');
assert.ok(
  Number(process.versions.node.split('.')[0]) >= 24,
  'Use Node 24+ for bodyChunkSent.',
);
const record = (event, fields = {}) =>
  appendFileSync(
    trace,
    JSON.stringify({ event, atMs: Date.now(), ...fields }) + '\n',
  );
const chunks = new WeakMap();
channel('undici:request:bodyChunkSent').subscribe(({ request, chunk }) => {
  if (String(request.origin) !== url.origin || request.method !== 'POST')
    return;
  const parts = chunks.get(request) ?? [];
  parts.push(Buffer.from(chunk));
  chunks.set(request, parts);
});
channel('undici:request:bodySent').subscribe(({ request }) => {
  if (String(request.origin) !== url.origin) return;
  if (request.method !== 'POST')
    return record('httpSent', { http: request.method });
  // Diagnostic subscribers must never throw into the networking stack.
  try {
    const msg = JSON.parse(Buffer.concat(chunks.get(request) ?? []).toString());
    chunks.delete(request);
    record('postSent', {
      method: msg.method,
      id: msg.id,
      targetId: msg.params?.requestId,
      attempt: msg.params?._meta?.['mcp-reliability-kit/attempt-id'],
    });
  } catch {
    record('undecodedPost');
  }
});

const attempt = key + '.1';
const args = { command: 'python3 -I worker.py', cwd: key, timeout_seconds: 20 };
const ms = Number(deadline);
const params = {
  name: 'start_task',
  arguments: args,
  _meta: { 'mcp-reliability-kit/attempt-id': attempt },
};
let invoke, close, protocol;
if (generation === 'kit') {
  const conn = await openConnection(
    { kind: 'http', url: endpoint },
    process.cwd(),
    { allowExternal: true, allowedUrls: [endpoint] },
    AbortSignal.timeout(30000),
    4000,
  );
  assert.equal(conn.checkTool('start_task', args), null);
  protocol = conn.protocol;
  close = conn.close;
  invoke = () => conn.invoke('start_task', args, ms, attempt);
} else {
  const legacy = generation === 'legacy';
  const client = legacy
    ? new LegacyClient({ name: 'mrk-legacy-observer', version: '1' })
    : new Client(
        { name: 'mrk-modern-observer', version: '1' },
        { versionNegotiation: { mode: 'auto', probe: { maxRetries: 0 } } },
      );
  const transport = legacy
    ? new LegacyHttp(url)
    : new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  protocol = legacy
    ? transport.protocolVersion
    : client.getNegotiatedProtocolVersion();
  const tools = await client.listTools();
  const tool = tools.tools.find((t) => t.name === 'start_task');
  assert.ok(tool);
  close = async () => {
    if (transport.sessionId) await transport.terminateSession();
    await client.close();
  };
  invoke = async () => {
    const options = {
      timeout: ms,
      maxTotalTimeout: ms,
      resetTimeoutOnProgress: false,
      onprogress: () => record('progress'),
    };
    try {
      const reply = legacy
        ? await client.callTool(params, undefined, options)
        : await client.callTool(params, { ...options, toolDefinition: tool });
      return reply.isError ? 'tool-error' : 'success';
    } catch (error) {
      if (
        legacy
          ? error instanceof McpError && error.code === ErrorCode.RequestTimeout
          : error instanceof SdkError &&
            error.code === SdkErrorCode.RequestTimeout
      )
        return 'timeout';
      throw error;
    }
  };
}
try {
  const start = performance.now();
  const result = await invoke();
  record('result', {
    result,
    protocol,
    deadlineMs: ms,
    elapsedMs: Math.round(performance.now() - start),
  });
  const stop = performance.now() + 15000;
  while (!existsSync(finish)) {
    if (performance.now() > stop)
      throw Error('Harness did not finish the observation');
    await delay(20);
  }
} finally {
  record('cleanupStarted');
  await close();
}
