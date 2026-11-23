import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { openConnection } from '../../dist/packages/core/connection.js';
import { once } from 'node:events';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { it, expect } from 'vitest';
import { paymentServer } from '../../dist/packages/fixtures/server.js';
import { runSuite } from '../../dist/packages/core/runner.js';
import { oneCase, options } from '../helpers.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing loopback port');
  return `http://127.0.0.1:${address.port}/mcp`;
}
async function close(server: Server) {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  server.closeAllConnections();
  await closed;
}
it('uses modern HTTP discovery, executes with an independent file observer and isolates repeated runs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-http-test-'));
  const file = join(temp, 'ledger.json');
  await writeFile(file, JSON.stringify({ version: 1, operations: {} }));
  const handler = createMcpHandler(() => paymentServer('safe', file), {
    legacy: 'reject',
  });
  const server = createServer(toNodeHandler(handler));
  try {
    const url = await listen(server);
    const { suite, t } = oneCase();
    suite.targets.ledger = { kind: 'http', url };
    t.verify = { kind: 'file', path: 'ledger.json' };
    const settings = {
      directory: temp,
      allowExternal: true,
      allowedUrls: [url],
    };
    const report = await runSuite(suite, settings);
    expect(report.results[0]).toMatchObject({
      status: 'PASS',
      protocolVersion: '2026-07-28',
      invocationCount: 2,
    });
    const second = (await runSuite(suite, settings)).results[0]!;
    expect(second.status).toBe('PASS');
    expect(second.operationKey).not.toBe(report.results[0]!.operationKey);
  } finally {
    await close(server);
    await rm(temp, { recursive: true, force: true });
  }
});
it('server observes a modern HTTP request disconnect after commit', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-cancel-http-'));
  const file = join(temp, 'ledger.json');
  await writeFile(file, '{"version":1,"operations":{}}');
  const server = createServer(
    toNodeHandler(createMcpHandler(() => paymentServer('safe', file, 0, true))),
  );
  try {
    const url = await listen(server);
    const { suite, t } = oneCase();
    suite.targets.ledger = { kind: 'http', url };
    t.verify = { kind: 'file', path: file };
    t.fault = { kind: 'timeout', deadlineMs: 250 };
    t.expectResponses = ['timeout'];
    const r = (
      await runSuite(suite, {
        ...options,
        allowExternal: true,
        allowedUrls: [url],
      })
    ).results[0]!;
    expect(r.status).toBe('PASS');
    expect(r.events.at(-1)?.entry).toMatchObject({
      effects: 1,
      cancellations: 1,
      settledAttempts: 1,
    });
  } finally {
    await close(server);
    await rm(temp, { recursive: true, force: true });
  }
});
it('refuses redirects without contacting the destination', async () => {
  let requests = 0;
  const sink = createServer((_req, res) => {
    requests++;
    res.end();
  });
  const redirect = createServer();
  try {
    const destination = await listen(sink);
    redirect.on('request', (_req, res) => {
      res.writeHead(307, { Location: destination });
      res.end();
    });
    const url = await listen(redirect);
    const { suite } = oneCase();
    suite.targets.ledger = { kind: 'http', url };
    suite.tests[0]!.verify = { kind: 'none' };
    const r = (
      await runSuite(suite, {
        ...options,
        allowExternal: true,
        allowedUrls: [url],
      })
    ).results[0]!;
    expect(r.status).toBe('ERROR');
    expect(requests).toBe(0);
  } finally {
    await close(redirect);
    await close(sink);
  }
});
it('keeps a stale observer inconclusive even when the retry returns success', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-stale-http-'));
  const ledger = join(temp, 'payments.json');
  const snapshot = join(temp, 'export.json');
  await writeFile(snapshot, '{"version":1,"operations":{}}');
  const server = createServer(
    toNodeHandler(createMcpHandler(() => paymentServer('safe', ledger))),
  );
  try {
    const url = await listen(server);
    const { suite, t } = oneCase();
    suite.targets.ledger = { kind: 'http', url };
    t.verify = { kind: 'file', path: snapshot };
    t.settleTimeoutMs = 80;
    const r = (
      await runSuite(suite, {
        ...options,
        allowExternal: true,
        allowedUrls: [url],
      })
    ).results[0]!;
    expect(r).toMatchObject({
      status: 'INCONCLUSIVE',
      invocationCount: 2,
      reason: 'unknown',
    });
    expect(r.assertions[0]).toMatchObject({
      name: 'responses',
      verdict: 'met',
    });
    expect(r.assertions[1]).toMatchObject({
      name: 'settlement',
      verdict: 'unknown',
    });
  } finally {
    await close(server);
    await rm(temp, { recursive: true, force: true });
  }
});

it('explicitly releases an allocated legacy HTTP session', async () => {
  const app = new McpServer(
    { name: 'session-test', version: '1' },
    { capabilities: { tools: {} } },
  );
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });
  await app.connect(transport);
  const deletes: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'DELETE')
      deletes.push(String(req.headers['mcp-session-id']));
    void transport.handleRequest(req, res);
  });
  try {
    const url = await listen(server);
    const conn = await openConnection(
      { kind: 'http', url },
      '.',
      { allowExternal: true, allowedUrls: [url] },
      AbortSignal.timeout(5000),
      1500,
    );
    const session = transport.sessionId;
    try {
      expect(conn.protocol).toBe('2025-11-25');
      expect(session).toBeTruthy();
    } finally {
      await conn.close();
    }
    expect(deletes).toEqual([session]);
  } finally {
    await app.close();
    await close(server);
  }
});

it('sends one HTTP tools/call when the server reports a header mismatch', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-http-count-'));
  const handler = createMcpHandler(() =>
    paymentServer('safe', join(temp, 'state.json')),
  );
  let requests = 0;
  const server = createServer(
    toNodeHandler({
      fetch: async (request: Request) => {
        if (request.method === 'POST') {
          const message = await request.clone().json();
          if (message.method === 'tools/call') {
            requests++;
            return Response.json({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32020, message: 'Header mismatch' },
            });
          }
        }
        return handler.fetch(request);
      },
    }),
  );
  try {
    const url = await listen(server);
    const conn = await openConnection(
      { kind: 'http', url },
      temp,
      { allowExternal: true, allowedUrls: [url] },
      AbortSignal.timeout(8000),
      2000,
    );
    try {
      expect(
        await conn.invoke(
          'record_payment',
          { operationKey: 'op-' + '1'.repeat(24), cents: 100 },
          2000,
        ),
      ).toBe('unknown');
      expect(requests).toBe(1);
    } finally {
      await conn.close();
    }
  } finally {
    await close(server);
    await rm(temp, { recursive: true, force: true });
  }
});
