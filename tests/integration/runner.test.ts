import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { parseSuite } from '../../dist/packages/contracts/index.js';
import { runSuite } from '../../dist/packages/core/runner.js';
import { openConnection } from '../../dist/packages/core/connection.js';
import { readEntry, awaitSettlement } from '../../dist/packages/core/ledger.js';
import {
  exitCode,
  junit,
  summary,
} from '../../dist/packages/reporters/index.js';
import { example, oneCase, options, directory } from '../helpers.js';

it('proves both controls and stable event ordering using real stdio', async () => {
  const safe = await runSuite(parseSuite(example), options);
  expect(safe.results.map((r) => r.status)).toEqual([
    'PASS',
    'PASS',
    'PASS',
    'PASS',
  ]);
  expect(safe.results.map((r) => r.invocationCount)).toEqual([2, 2, 1, 2]);
  expect(safe.results.map((r) => r.protocolVersion)).toEqual(
    Array(4).fill('2026-07-28'),
  );
  const lost = safe.results[1]!;
  expect(lost.events.map((e) => e.kind)).toEqual([
    'connected',
    'baseline',
    'invoke',
    'reply-withheld',
    'before-retry',
    'invoke',
    'reply',
    'state',
  ]);
  expect(safe.results[2]!.events.at(-1)?.entry).toMatchObject({
    effects: 1,
    settledAttempts: 1,
    cancellations: 1,
  });
  const unsafe = await runSuite(
    parseSuite(example.replace('mode: safe', 'mode: unsafe')),
    options,
  );
  expect(unsafe.results.map((r) => r.status)).toEqual([
    'FAIL',
    'FAIL',
    'PASS',
    'PASS',
  ]);
  expect(unsafe.results[1]!.assertions.at(-1)).toMatchObject({
    name: 'effects',
    actual: 2,
    verdict: 'violated',
  });
  expect(lost.operationKey).toBe(unsafe.results[1]!.operationKey);
  expect(exitCode(unsafe)).toBe(1);
  expect(junit(unsafe)).toContain('failures="2"');
});

it('keeps unavailable independent state inconclusive after a withheld response', async () => {
  const { suite, t } = oneCase();
  t.verify = { kind: 'none' };
  const report = await runSuite(suite, options);
  expect(report.results[0]).toMatchObject({
    status: 'INCONCLUSIVE',
    invocationCount: 2,
  });
  expect(summary(report)).toContain('effects=?');
  expect(junit(report)).toContain('<skipped type="INCONCLUSIVE"');
  expect(exitCode(report)).toBe(3);
});
it('never launches a process for unauthorized cases or unsupported injection', async () => {
  const { suite, t } = oneCase();
  suite.targets.ledger = {
    kind: 'stdio',
    command: 'no-such-executable',
    args: [],
  };
  expect((await runSuite(suite, options)).results[0]).toMatchObject({
    reason: 'permission',
    events: [],
  });
  t.allowSideEffects = false;
  expect((await runSuite(suite, options)).results[0]).toMatchObject({
    status: 'SKIPPED',
    reason: 'denied',
    events: [],
  });
  t.allowSideEffects = true;
  t.fault = { kind: 'transient', failures: 1, maxRetries: 1 };
  expect((await runSuite(suite, options)).results[0]).toMatchObject({
    status: 'SKIPPED',
    reason: 'fixtureOnly',
    events: [],
  });
});
it('handles an absent tool before dispatch', async () => {
  const { suite, t } = oneCase();
  t.tool = 'missing';
  const r = (await runSuite(suite, options)).results[0]!;
  expect(r).toMatchObject({
    status: 'ERROR',
    reason: 'missing',
    invocationCount: 0,
  });
});
it('keeps input and server error payloads out of all reports', async () => {
  const { suite, t } = oneCase();
  t.arguments.cents = 'sensitive-test-value';
  t.arguments.extra = 'sensitive-test-value';
  const report = await runSuite(suite, options);
  expect(report.results[0]).toMatchObject({
    status: 'ERROR',
    reason: 'arguments',
    invocationCount: 0,
  });
  for (const output of [JSON.stringify(report), junit(report), summary(report)])
    expect(output).not.toContain('sensitive-test-value');
});
it('deduplicates across process restarts while the same durable ledger survives', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-book-test-'));
  const path = join(temp, 'state.json');
  const key = 'op-' + 'f'.repeat(24);
  await writeFile(path + '.next', 'preserve the existing file');
  try {
    for (let i = 0; i < 2; i++) {
      const conn = await openConnection(
        {
          kind: 'stdio',
          command: process.execPath,
          args: [join(directory, 'examples/safe-mcp-server/server.mjs'), path],
        },
        temp,
        { allowExternal: true, allowStdio: true, allowedUrls: [] },
        AbortSignal.timeout(6000),
        2000,
      );
      try {
        expect(
          await conn.invoke(
            'record_payment',
            { operationKey: key, cents: 50 },
            2000,
          ),
        ).toBe('success');
      } finally {
        await conn.close();
      }
    }
    expect(await readFile(path + '.next', 'utf8')).toBe(
      'preserve the existing file',
    );
    expect(await readEntry(path, key)).toMatchObject({
      entry: { effects: 1, settledAttempts: 2 },
    });
    expect(
      JSON.parse(await readFile(path, 'utf8')).operations[key].receipts,
    ).toEqual([50]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it('checks settlement separately from the effect count', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-settle-test-'));
  try {
    const file = join(temp, 'state.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        operations: { key: { effects: 1, settledAttempts: 0 } },
      }),
    );
    expect(
      await awaitSettlement(file, 'key', 2, 50, AbortSignal.timeout(1000)),
    ).toMatchObject({ entry: { effects: 1, settledAttempts: 0 } });
    await writeFile(file, 'invalid ledger');
    expect(await readEntry(file, 'key')).toEqual({ available: false });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it('derives the fixture count directly from receipts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-count-test-'));
  try {
    const file = join(temp, 'state.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        operations: {
          k: { receipts: [50, 50], effects: 1, settledAttempts: 2 },
        },
      }),
    );
    expect(await readEntry(file, 'k', true)).toMatchObject({
      entry: { effects: 2 },
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it('removes the fixture ledger on close', async () => {
  const conn = await openConnection(
    { kind: 'fixture', mode: 'safe' },
    directory,
    options,
    AbortSignal.timeout(7000),
    2000,
  );
  const path = conn.ledger!;
  await conn.close();
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('negotiates session-based stdio and observes its cancellation', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-legacy-test-'));
  try {
    const { suite, t } = oneCase();
    const ledger = join(temp, 'ledger.json');
    suite.targets.ledger = {
      kind: 'stdio',
      command: process.execPath,
      args: [join(directory, 'tests/integration/legacy-server.mjs'), ledger],
    };
    t.fault = { kind: 'timeout', deadlineMs: 250 };
    t.expectResponses = ['timeout'];
    t.verify = { kind: 'file', path: ledger };
    const result = (
      await runSuite(suite, {
        ...options,
        allowExternal: true,
        allowStdio: true,
      })
    ).results[0]!;
    expect(result).toMatchObject({
      status: 'PASS',
      protocolVersion: '2025-11-25',
    });
    expect(result.events.at(-1)?.entry).toMatchObject({
      cancellations: 1,
      effects: 1,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it('skips a discovered task-only tool before any invocation', async () => {
  const { suite, t } = oneCase();
  t.tool = 'background_job';
  t.verify = { kind: 'none' };
  suite.targets.ledger = {
    kind: 'stdio',
    command: process.execPath,
    args: [join(directory, 'tests/integration/task-only.mjs')],
  };
  const r = (
    await runSuite(suite, { ...options, allowExternal: true, allowStdio: true })
  ).results[0]!;
  expect(r).toMatchObject({
    status: 'SKIPPED',
    reason: 'taskRequired',
    invocationCount: 0,
  });
});
it('preserves prior receipts when a crash leaves the fixture lock in place', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-lock-'));
  const path = join(temp, 'ledger.json');
  const target = {
    kind: 'stdio' as const,
    command: process.execPath,
    args: [join(directory, 'examples/safe-mcp-server/server.mjs'), path],
  };
  const open = () =>
    openConnection(
      target,
      temp,
      { allowExternal: true, allowStdio: true, allowedUrls: [] },
      AbortSignal.timeout(6000),
      1500,
    );
  const args = { operationKey: 'op-' + 'a'.repeat(24), cents: 100 };
  try {
    const first = await open();
    try {
      expect(await first.invoke('record_payment', args, 1500)).toBe('success');
    } finally {
      await first.close();
    }
    await writeFile(path + '.lock', '');
    const before = await readFile(path, 'utf8');
    const second = await open();
    try {
      expect(await second.invoke('record_payment', args, 1500)).toBe(
        'tool-error',
      );
    } finally {
      await second.close();
    }
    expect(await readFile(path, 'utf8')).toBe(before);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it('serializes durable payment updates across two live fixture processes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-writers-'));
  const path = join(temp, 'ledger.json'),
    key = 'op-' + 'b'.repeat(24);
  const target = {
    kind: 'stdio' as const,
    command: process.execPath,
    args: [join(directory, 'examples/safe-mcp-server/server.mjs'), path],
  };
  const connections: Awaited<ReturnType<typeof openConnection>>[] = [];
  try {
    for (let i = 0; i < 2; i++)
      connections.push(
        await openConnection(
          target,
          temp,
          { allowExternal: true, allowStdio: true, allowedUrls: [] },
          AbortSignal.timeout(8000),
          2000,
        ),
      );
    const replies = await Promise.all(
      connections.map((c) =>
        c.invoke('record_payment', { operationKey: key, cents: 125 }, 2000),
      ),
    );
    expect(replies).toContain('success');
    // A lock loser can be explicitly retried after both initial calls return.
    for (const [i, response] of replies.entries())
      if (response !== 'success') {
        expect(response).toBe('tool-error');
        expect(
          await connections[i]!.invoke(
            'record_payment',
            { operationKey: key, cents: 125 },
            2000,
          ),
        ).toBe('success');
      }
    const row = JSON.parse(await readFile(path, 'utf8')).operations[key];
    expect(row.receipts).toEqual([125]);
    expect(row.settledAttempts).toBe(2);
  } finally {
    await Promise.all(connections.map((c) => c.close()));
    await rm(temp, { recursive: true, force: true });
  }
});
