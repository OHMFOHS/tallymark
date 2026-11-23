import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { it, expect } from 'vitest';
import { directory, example } from '../helpers.js';
import { paymentServer } from '../../dist/packages/fixtures/server.js';
import { parseSuite } from '../../packages/contracts/index.js';
const cli = join(directory, 'dist/packages/cli/main.js');
it('diagnoses a real HTTP server through discovery alone', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-doctor-'));
  const app = createMcpHandler(() =>
    paymentServer('unsafe', join(temp, 'state.json')),
  );
  const methods: string[] = [];
  const server = createServer(
    toNodeHandler({
      fetch: async (req, options) => {
        if (req.method === 'POST')
          methods.push((await req.clone().json()).method);
        return app.fetch(req, options);
      },
    }),
  );
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw Error('Missing loopback port');
    const url = `http://127.0.0.1:${addr.port}/mcp`;
    const { stdout } = await promisify(execFile)(process.execPath, [
      cli,
      'doctor',
      '--url',
      url,
      '--json',
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      safety: 'unassessed',
      toolCalls: 0,
      tools: [{ name: 'record_payment' }],
    });
    expect(methods).toContain('tools/list');
    expect(methods).not.toContain('tools/call');
    const prior = [...methods];
    const config = join(temp, 'http.yaml');
    const generate = (...opts: string[]) =>
      spawnSync(process.execPath, [cli, 'init', '-c', config, ...opts], {
        encoding: 'utf8',
      });
    expect(generate('--url', url).status).toBe(2);
    expect(
      generate('--url', url, '--tool', 'record_payment', '--fixture', 'unsafe')
        .status,
    ).toBe(2);
    expect(generate('--url', url, '--tool', 'record_payment').status).toBe(0);
    expect(generate('--url', url, '--tool', 'different_tool').status).toBe(2);
    const suite = parseSuite(await readFile(config, 'utf8'));
    expect(suite.tests[0]).toMatchObject({
      tool: 'record_payment',
      allowSideEffects: false,
      mode: 'observational',
    });
    expect(methods).toEqual(prior);
    const run = () =>
      promisify(execFile)(process.execPath, [
        cli,
        'test',
        '-c',
        config,
        '--out',
        join(temp, 'out'),
        '--allow-external',
        '--allow-url',
        url,
      ]);
    await expect(run()).rejects.toMatchObject({
      code: 3,
      stdout: expect.stringContaining('SKIPPED'),
    });
    expect(methods).toEqual(prior);
    suite.tests[0]!.allowSideEffects = true;
    suite.tests[0]!.arguments = {
      cents: 1250,
      operationKey: '{{operationKey}}',
    };
    await writeFile(config, JSON.stringify(suite));
    await expect(run()).rejects.toMatchObject({
      code: 3,
      stdout: expect.stringContaining('INCONCLUSIVE'),
    });
    expect(methods.filter((m) => m === 'tools/call')).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
});
it('requires permission for a reviewed stdio file and never persists a payment during doctor', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-doctor-'));
  const target = join(temp, 'target.json'),
    ledger = join(temp, 'ledger.json');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'doctor', ...args], { encoding: 'utf8' });
  try {
    await writeFile(
      target,
      JSON.stringify({
        kind: 'stdio',
        command: process.execPath,
        args: [
          join(directory, 'examples/unsafe-mcp-server/server.mjs'),
          ledger,
        ],
      }),
    );
    expect(run('--stdio-config', target).status).toBe(2);
    expect(await readdir(temp)).toEqual(['target.json']);
    expect(run('--stdio-config', target, '--allow-stdio').stdout).toContain(
      'Tool calls: 0',
    );
    expect(JSON.parse(await readFile(ledger, 'utf8')).operations).toEqual({});
    expect(run('--url', 'https://example.invalid/mcp').stderr).toContain(
      '--allow-url',
    );
    expect(
      run('--url', 'https://example.invalid/mcp?key=private-marker').stderr,
    ).not.toContain('private-marker');
    expect(
      run(
        '--url',
        'http://example.invalid/mcp',
        '--allow-url',
        'http://example.invalid/mcp',
      ).status,
    ).toBe(2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it('reproduces one case and derives terminal and JSON findings from its measured evidence', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-finding-'));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      cwd: temp,
    });
  try {
    await writeFile(
      join(temp, 'suite.yaml'),
      example.replace('mode: safe', 'mode: unsafe'),
    );
    const live = run(
      'test',
      '-c',
      'suite.yaml',
      '--case',
      'lost-reply',
      '--out',
      'out',
    );
    expect(live.status).toBe(1);
    const [folder] = await readdir(join(temp, 'out'));
    const path = join(temp, 'out', folder!, 'report.json');
    const data = JSON.parse(await readFile(path, 'utf8'));
    expect(data.planned).toEqual(['lost-reply']);
    expect(data.findings[0]).toMatchObject({
      caseId: 'lost-reply',
      tool: 'record_payment',
      scenario: 'lost-response',
      severity: 'high',
      observed: { highestObservedEffects: 2, completeTerminalSet: true },
      expected: { invariant: { maxEffects: 1 } },
    });
    expect(live.stdout).toContain(data.findings[0].conclusion);
    data.findings[0].conclusion = 'untrusted-narrative-marker';
    await writeFile(path, JSON.stringify(data));
    expect(run('report', path).stdout).not.toContain(
      'untrusted-narrative-marker',
    );
    expect(run('test', '-c', 'suite.yaml', '--case', 'unlisted').status).toBe(
      2,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
