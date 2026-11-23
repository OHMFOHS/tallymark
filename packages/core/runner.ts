import { createHash, randomUUID } from 'node:crypto';
import { attemptId, type PendingAttempt } from '../contracts/attempt.js';
import { resolve } from 'node:path';
import {
  PublicError,
  type Case,
  type Suite,
  type Target,
} from '../contracts/index.js';
import {
  openConnection,
  requirePermission,
  type Permissions,
} from './connection.js';
import type { Result, Event, Report } from './evidence.js';
import { assess } from './verdict.js';
import {
  readEntry,
  awaitSettlement,
  trackReadings,
  allSettled,
  type Reading,
} from './ledger.js';

export interface RunOptions extends Permissions {
  directory: string;
  signal?: AbortSignal;
  onBeforeInvoke?: (attempt: PendingAttempt) => Promise<void>;
  onCaseComplete?: (report: Report) => Promise<void>;
}
class JournalWriteError extends PublicError {}
type Connection = Awaited<ReturnType<typeof openConnection>>;

function record(r: Result, event: Omit<Event, 'seq'>) {
  r.events.push({ seq: r.events.length + 1, ...event });
}
function observe(
  r: Result,
  kind: 'baseline' | 'before-retry' | 'state',
  state: Reading,
) {
  record(r, {
    kind,
    reading: !state.available
      ? state.inconsistent
        ? 'inconsistent'
        : 'unavailable'
      : state.entry
        ? 'present'
        : 'absent',
    ...(state.available && state.ageMs !== undefined
      ? { ageMs: state.ageMs }
      : {}),
    entry: state.available ? (state.entry ?? undefined) : undefined,
  });
}
function conclude(
  r: Result,
  status: Result['status'],
  reason: Result['reason'],
) {
  r.status = status;
  r.reason = reason;
}

async function schedule(
  t: Case,
  conn: Connection,
  args: Record<string, unknown>,
  r: Result,
  checkpoint: (calls: number) => Promise<Reading>,
  beforeInvoke: RunOptions['onBeforeInvoke'],
): Promise<Reading | undefined> {
  const f = t.fault;
  const count =
    f.kind === 'timeout' || f.kind === 'none' ? 1 : 1 + f.maxRetries;
  for (let i = 1; i <= count; i++) {
    const id = attemptId(r.operationKey, i);
    try {
      await beforeInvoke?.({
        caseId: t.id,
        tool: t.tool,
        operationKey: r.operationKey,
        ordinal: i,
      });
    } catch {
      throw new JournalWriteError(
        'Could not save the pending attempt. Dispatch stopped. Inspect the last progress journal and reconcile any earlier attempts.',
      );
    }
    record(r, { kind: 'invoke', attempt: i, attemptId: id });
    r.invocationCount++;
    const reply = await conn.invoke(
      t.tool,
      args,
      f.kind === 'timeout' ? f.deadlineMs : t.requestTimeoutMs,
      id,
    );
    // Only a completed SDK response can be withheld. Its content and success
    // bit do not cross the simulated application delivery boundary.
    const withheld =
      f.kind === 'lost-response' &&
      i === 1 &&
      (reply === 'success' || reply === 'tool-error');
    const visible = withheld ? 'lost' : reply;
    record(r, {
      kind: withheld ? 'reply-withheld' : 'reply',
      attempt: i,
      response: visible,
    });
    if (reply === 'unknown' || reply === 'timeout') break;
    if (f.kind === 'transient' && (reply !== 'tool-error' || i > f.failures))
      break;
    if (f.kind === 'duplicate' && reply !== 'success') break;
    if (i < count) {
      const state = await checkpoint(i);
      observe(r, 'before-retry', state);
      if (
        (!state.available && state.inconsistent) ||
        (state.available &&
          state.entry &&
          state.entry.effects > t.invariant.maxEffects) ||
        (r.config.retryPolicy === 'after-settlement' &&
          (!state.available || !allSettled(state.entry, r.operationKey, i)))
      )
        return state;
    }
  }
}

async function runCase(
  t: Case,
  seed: number,
  target: Target,
  options: RunOptions,
  suiteSignal: AbortSignal,
  scenarioVersion: 3 | 4,
): Promise<Result> {
  // Fresh external keys prevent overlapping CI runs from sharing evidence.
  const namespace =
    target.kind === 'fixture' && t.verify.kind !== 'file'
      ? 'fixture'
      : randomUUID();
  const key =
    'op-' +
    createHash('sha256')
      .update(JSON.stringify([namespace, seed, t.id]))
      .digest('hex')
      .slice(0, 24);
  const maxAgeMs = t.verify.kind === 'file' ? t.verify.maxAgeMs : undefined;
  const r: Result = {
    id: t.id,
    operationKey: key,
    scenarioVersion,
    protocolVersion: null,
    invocationCount: 0,
    status: 'ERROR',
    reason: 'internal',
    events: [],
    assertions: [],
    config: {
      id: t.id,
      target: t.target,
      mode: t.mode ?? (t.verify.kind === 'none' ? 'observational' : 'verified'),
      retryPolicy:
        t.retryPolicy ??
        (t.mode === 'verified' ? 'after-settlement' : 'scheduled'),
      transport:
        target.kind === 'fixture'
          ? { ...target }
          : { kind: target.kind, endpoint: '[redacted]' },
      tool: t.tool,
      arguments: '[redacted]',
      allowSideEffects: t.allowSideEffects,
      fault: t.fault,
      expectResponses: t.expectResponses,
      verify: {
        kind: t.verify.kind,
        ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
      },
      invariant: t.invariant,
      requestTimeoutMs: t.requestTimeoutMs,
      settleTimeoutMs: t.settleTimeoutMs,
    },
  };
  if (!t.allowSideEffects) {
    conclude(r, 'SKIPPED', 'denied');
    return r;
  }
  if (t.fault.kind === 'transient' && target.kind !== 'fixture') {
    conclude(r, 'SKIPPED', 'fixtureOnly');
    return r;
  }
  try {
    requirePermission(target, options);
  } catch {
    conclude(r, 'ERROR', 'permission');
    return r;
  }
  const signal = AbortSignal.any([suiteSignal, AbortSignal.timeout(30000)]);
  let conn: Connection | undefined;
  try {
    conn = await openConnection(
      target,
      options.directory,
      options,
      signal,
      t.requestTimeoutMs,
      t.fault,
    );
    r.protocolVersion = conn.protocol;
    record(r, { kind: 'connected' });
    const args = JSON.parse(JSON.stringify(t.arguments), (_k, v: unknown) =>
      v === '{{operationKey}}' ? key : v,
    ) as Record<string, unknown>;
    const issue = conn.checkTool(t.tool, args);
    if (issue) {
      conclude(r, issue === 'taskRequired' ? 'SKIPPED' : 'ERROR', issue);
      return r;
    }
    const path =
      t.verify.kind === 'fixture'
        ? conn.ledger
        : t.verify.kind === 'file'
          ? resolve(options.directory, t.verify.path)
          : undefined;
    const builtin = t.verify.kind === 'fixture';
    const read = trackReadings(() => readEntry(path, key, builtin, maxAgeMs));
    const baseline = await read();
    observe(r, 'baseline', baseline);
    if (baseline.available && baseline.entry) {
      conclude(r, 'ERROR', 'dirty');
      return r;
    }
    if (
      !baseline.available &&
      t.mode !== 'observational' &&
      (target.kind !== 'fixture' || t.verify.kind !== 'none')
    ) {
      conclude(
        r,
        'INCONCLUSIVE',
        t.verify.kind === 'none' ? 'observerRequired' : 'baselineUnavailable',
      );
      return r;
    }
    const settle = (calls: number) =>
      awaitSettlement(
        path,
        key,
        calls,
        t.settleTimeoutMs,
        signal,
        builtin,
        t.invariant.maxEffects,
        read,
      );
    const stopped = await schedule(
      t,
      conn,
      args,
      r,
      settle,
      options.onBeforeInvoke,
    );
    const state = stopped ?? (await settle(r.invocationCount));
    observe(r, 'state', state);
    Object.assign(r, assess(t, r));
  } catch (error) {
    if (error instanceof JournalWriteError) throw error;
    conclude(
      r,
      signal.aborted && r.invocationCount > 0 ? 'INCONCLUSIVE' : 'ERROR',
      signal.aborted ? 'deadline' : conn ? 'internal' : 'connection',
    );
  } finally {
    if (conn)
      try {
        await conn.close();
      } catch {
        conclude(r, 'ERROR', 'cleanup');
      }
  }
  return r;
}

export async function runSuite(
  suite: Suite,
  options: RunOptions,
): Promise<Report> {
  const deadline = AbortSignal.timeout(120000);
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  const version = suite.tests.some(
    (t) => t.verify.kind === 'file' && t.verify.maxAgeMs !== undefined,
  )
    ? 4
    : 3;
  const report: Report = {
    reportVersion: version,
    contractVersion: 1,
    planned: suite.tests.map((test) => test.id),
    seed: suite.seed,
    results: [],
  };
  for (const test of suite.tests) {
    report.results.push(
      await runCase(
        test,
        suite.seed,
        suite.targets[test.target]!,
        options,
        signal,
        version,
      ),
    );
    await options.onCaseComplete?.(report);
  }
  return report;
}
