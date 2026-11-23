import { exercisesFault, type Case } from '../contracts/index.js';
import { allSettled, regresses } from './ledger.js';
import type { Result } from './evidence.js';

type Decision = Pick<Result, 'assertions' | 'status' | 'reason'>;
export function assess(
  policy: Pick<Case, 'fault' | 'expectResponses' | 'invariant'>,
  result: Result,
): Decision {
  const checks: Result['assertions'] = [];
  const finish = (
    status: Result['status'],
    reason: Result['reason'],
  ): Decision => ({ assertions: checks, status, reason });
  const replies = result.events
    .filter((e) => e.kind === 'reply' || e.kind === 'reply-withheld')
    .map((e) => e.response);
  const actual = replies.join(', '),
    expected = policy.expectResponses.join(', ');
  const unknown = replies.includes('unknown') || replies.includes(undefined);
  checks.push({
    name: 'responses',
    expected,
    actual,
    verdict: unknown ? 'unknown' : actual === expected ? 'met' : 'violated',
  });
  const final = result.events.find((e) => e.kind === 'state');
  const entry = final?.reading === 'present' ? final.entry : undefined;
  const settled = allSettled(
    entry,
    result.operationKey,
    result.invocationCount,
  );
  checks.push({
    name: 'settlement',
    expected: result.invocationCount,
    actual: entry?.settledAttempts ?? null,
    verdict: settled ? 'met' : 'unknown',
  });
  const checkpoints = result.events.filter((e) => e.kind === 'before-retry');
  const checkpoint = checkpoints[0];
  const first =
    checkpoint?.reading === 'present' ? checkpoint.entry : undefined;
  const { minEffects, maxEffects } = policy.invariant;
  // A committed receipt is monotonic. A witnessed excess already disproves
  // the upper bound even if a child crashes before recording settlement.
  const highest = Math.max(
    0,
    ...checkpoints.map((e) => e.entry?.effects ?? 0),
    entry?.effects ?? 0,
  );
  const excess = highest > maxEffects;
  const inRange =
    entry !== undefined &&
    entry.effects >= minEffects &&
    entry.effects <= maxEffects;
  checks.push({
    name: 'effects',
    expected: `${minEffects}..${maxEffects}`,
    actual: excess ? highest : (entry?.effects ?? null),
    verdict: excess
      ? 'violated'
      : settled
        ? inRange
          ? 'met'
          : 'violated'
        : 'unknown',
  });
  if (excess) return finish('FAIL', 'invariant');
  const observations = [...checkpoints, final];
  if (
    observations.some(
      (e, i) =>
        e?.reading === 'inconsistent' ||
        (i > 0 &&
          observations[i - 1]?.entry &&
          e?.entry &&
          regresses(observations[i - 1]!.entry!, e.entry)),
    )
  )
    return finish('INCONCLUSIVE', 'inconsistent');
  if (
    result.config.retryPolicy === 'after-settlement' &&
    replies.length < policy.expectResponses.length &&
    checkpoints.length === replies.length &&
    !settled
  ) {
    checks[0]!.verdict = 'unknown';
    return finish('INCONCLUSIVE', 'retryBlocked');
  }
  if (settled && !inRange) return finish('FAIL', 'invariant');
  if (!exercisesFault(policy) || (!unknown && actual !== expected))
    return finish('FAIL', 'responses');
  if (result.config.mode === 'observational')
    return finish('INCONCLUSIVE', unknown ? 'transport' : 'observed');
  if (!settled) return finish('INCONCLUSIVE', 'unknown');
  if (result.invocationCount > 1) {
    const required = result.invocationCount - 1;
    const witnessed = checkpoints.filter(
      (e, i) =>
        e.reading === 'present' &&
        allSettled(e.entry, result.operationKey, i + 1),
    ).length;
    const met = checkpoints.length === required && witnessed === required;
    checks.push({
      name: 'retrySettlement',
      expected: required,
      actual: witnessed,
      verdict: met ? 'met' : 'unknown',
    });
    if (!met) return finish('INCONCLUSIVE', 'retryEvidence');
  }
  if (
    policy.fault.kind === 'transient' &&
    checkpoints.some((e) => e.entry!.effects > 0)
  )
    return finish('FAIL', 'precommit');
  if (unknown) return finish('INCONCLUSIVE', 'transport');
  if (policy.fault.kind === 'lost-response') {
    const witnessed =
      first !== undefined &&
      first.effects > 0 &&
      allSettled(first, result.operationKey, 1) &&
      first.effects <= (entry?.effects ?? 0);
    checks.push({
      name: 'firstEffect',
      expected: 'one settled attempt with committed effects',
      actual: first?.effects ?? null,
      verdict: witnessed ? 'met' : 'unknown',
    });
    if (!witnessed) return finish('INCONCLUSIVE', 'firstEffect');
  }
  if (policy.fault.kind === 'timeout') {
    if (actual !== 'timeout') return finish('FAIL', 'responses');
    const n = entry?.cancellations;
    checks.push({
      name: 'cancellation',
      expected: 1,
      actual: n ?? null,
      verdict: n === undefined ? 'unknown' : n === 1 ? 'met' : 'violated',
    });
    if (n === undefined) return finish('INCONCLUSIVE', 'cancellationUnknown');
    if (n !== 1) return finish('FAIL', 'cancellation');
  }
  return finish('PASS', 'verified');
}
