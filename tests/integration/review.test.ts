import { mkdtemp, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { runSuite } from '../../dist/packages/core/runner.js';
import { reportSchema } from '../../packages/core/evidence.js';
import { oneCase, options, directory } from '../helpers.js';

async function reviewCase(
  mode: string,
  timeout = false,
  retryMode?: 'verified' | 'scheduled',
) {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-review-'));
  try {
    const ledger = join(temp, 'ledger.json');
    await writeFile(
      ledger,
      JSON.stringify({
        version: 1,
        operations: {},
        ...(mode === 'fresh' ? { publishedAt: new Date().toISOString() } : {}),
      }),
    );
    const { suite, t } = oneCase();
    suite.targets.ledger = {
      kind: 'stdio',
      command: process.execPath,
      args: [
        join(directory, 'tests/integration/review-server.mjs'),
        ledger,
        mode,
      ],
    };
    t.verify = {
      kind: 'file',
      path: ledger,
      ...(mode === 'fresh' ? { maxAgeMs: 30000 } : {}),
    };
    t.settleTimeoutMs = 200;
    if (retryMode) {
      t.mode = 'verified';
      t.retryPolicy =
        retryMode === 'verified' ? 'after-settlement' : 'scheduled';
      t.fault = { kind: 'duplicate', maxRetries: 1 };
      t.expectResponses = ['success', 'success'];
    }
    if (timeout) {
      t.fault = { kind: 'timeout', deadlineMs: 120 };
      t.expectResponses = ['timeout'];
    }
    const report = await runSuite(suite, {
      ...options,
      allowExternal: true,
      allowStdio: true,
    });
    const result = report.results[0]!;
    if (mode === 'fresh') {
      expect(report.reportVersion).toBe(4);
      expect(reportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(
        report,
      );
    }
    if (mode === 'startup')
      expect(
        (await readFile(ledger + '.starts', 'utf8')).trim().split('\n'),
      ).toHaveLength(2);
    if (mode === 'delayed') {
      // Only the first attempt was terminal while the runner could observe it.
      expect(result.events.at(-1)?.entry).toMatchObject({
        effects: 1,
        settledAttempts: 1,
      });
      const job = JSON.parse(await readFile(ledger + '.pending', 'utf8'));
      await writeFile(
        ledger + '.next',
        JSON.stringify({
          version: 1,
          operations: {
            [job.key]: {
              effects: 2,
              settledAttempts: 2,
              settledAttemptIds: job.ids,
            },
          },
        }),
      );
      await rename(ledger + '.next', ledger);
      expect(
        JSON.parse(await readFile(ledger, 'utf8')).operations[
          result.operationKey
        ].effects,
      ).toBe(2);
    }
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
it.each(['first-rejected', 'first-empty'])(
  'requires an independently witnessed first effect before certifying a lost-reply retry (%s)',
  async (mode) => {
    const result = await reviewCase(mode);
    expect(result.assertions.find((a) => a.name === 'effects')?.actual).toBe(1);
    expect(result.status).toBe('INCONCLUSIVE');
  },
);
it.each([
  ['ignore-cancel', 'FAIL'],
  ['no-telemetry', 'INCONCLUSIVE'],
])('uses external cancellation evidence (%s)', async (mode, status) => {
  expect((await reviewCase(mode, true)).status).toBe(status);
});
it('reports an irreversible upper-bound violation even with an unfinished attempt', async () => {
  expect(await reviewCase('unsettled-excess')).toMatchObject({
    status: 'FAIL',
    reason: 'invariant',
  });
});
it('stops after a process exits between commit and settlement', async () => {
  expect(await reviewCase('crash')).toMatchObject({
    status: 'INCONCLUSIVE',
    invocationCount: 1,
  });
});
it('rejects two terminal acknowledgements for the same attempt', async () => {
  expect(await reviewCase('duplicate-ack')).toMatchObject({
    status: 'INCONCLUSIVE',
    reason: 'unknown',
  });
});

it('keeps an unfinished downstream job inconclusive when its duplicate effect arrives after the deadline', async () => {
  expect(await reviewCase('delayed')).toMatchObject({
    status: 'INCONCLUSIVE',
    invocationCount: 2,
  });
});
it('reads a legacy count-only exporter without certifying its uncorrelated attempts', async () => {
  expect(await reviewCase('count-only')).toMatchObject({
    status: 'INCONCLUSIVE',
    invocationCount: 2,
  });
});
it('discards actual server content after successful dispatch', async () => {
  const result = await reviewCase('normal');
  expect(result.status).toBe('PASS');
  expect(JSON.stringify(result)).not.toContain(
    'synthetic-private-response-marker',
  );
});

it('certifies timestamped independent observations only with a freshness-aware report version', async () => {
  const result = await reviewCase('fresh', false, 'verified');
  expect(result.status).toBe('PASS');
  const checkpoints = result.events.filter((e) => e.reading !== undefined);
  expect(checkpoints.map((e) => e.kind)).toEqual([
    'baseline',
    'before-retry',
    'state',
  ]);
  for (const e of checkpoints) expect(e.ageMs).toEqual(expect.any(Number));
});

it('accounts for the SDK probe executable and session executable', async () => {
  expect((await reviewCase('startup')).status).toBe('PASS');
});

it('stops before a second dispatch when the first committed effects already exceed the limit', async () => {
  expect(await reviewCase('first-excess')).toMatchObject({
    status: 'FAIL',
    reason: 'invariant',
    invocationCount: 1,
  });
});

it('withholds verified retries if a successful reply precedes settlement', async () => {
  const result = await reviewCase('pending-first', false, 'verified');
  expect(result.assertions[0]?.verdict).toBe('unknown');
  expect(result).toMatchObject({
    status: 'INCONCLUSIVE',
    reason: 'retryBlocked',
    invocationCount: 1,
  });
});
it('keeps an overlapping scheduled replay inconclusive even if both final IDs later appear', async () => {
  expect(await reviewCase('pending-first', false, 'scheduled')).toMatchObject({
    status: 'INCONCLUSIVE',
    reason: 'retryEvidence',
    invocationCount: 2,
  });
});
it('waits for a delayed terminal export before issuing an authorized verified retry', async () => {
  const result = await reviewCase('late-visibility', false, 'verified');
  expect(result.status).toBe('PASS');
  expect(
    result.events.find((e) => e.kind === 'before-retry')?.entry
      ?.settledAttemptIds,
  ).toEqual([result.operationKey + '.1']);
});
