import { it, expect, beforeAll } from 'vitest';
import { runSuite } from '../../dist/packages/core/runner.js';
import { reportSchema, type Report } from '../../packages/core/evidence.js';
import { oneCase, options } from '../helpers.js';
let report: Report;
beforeAll(async () => {
  report = await runSuite(oneCase().suite, options);
});
it('validates emitted positive evidence after a JSON round trip', () => {
  expect(report.results[0]?.status).toBe('PASS');
  expect(reportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(
    report,
  );
});
it.each([
  'no evidence',
  'missing call',
  'changed upper bound',
  'impossible response',
  'missing observer',
  'reordered event',
  'changed assertion',
  'repeated attempt ID',
])('refuses contradictory saved PASS (%s)', (change) => {
  const copy = structuredClone(report);
  const row = copy.results[0]!;
  if (change === 'no evidence') {
    row.events = [];
    row.assertions = [];
    row.invocationCount = 0;
  }
  if (change === 'missing call') row.invocationCount--;
  if (change === 'changed upper bound')
    row.config.invariant = { minEffects: 0, maxEffects: 0 };
  if (change === 'impossible response')
    row.config.expectResponses = ['lost', 'timeout'];
  if (change === 'missing observer') row.config.verify = { kind: 'none' };
  if (change === 'reordered event') row.events.reverse();
  if (change === 'changed assertion') row.assertions[2]!.actual = 8;
  if (change === 'repeated attempt ID')
    row.events.at(-1)!.entry!.settledAttemptIds!.fill(row.operationKey + '.1');
  expect(reportSchema.safeParse(copy).success).toBe(false);
});
it('preserves historical observations without returning a green v2 verdict', () => {
  const copy = structuredClone(report);
  copy.reportVersion = 1;
  copy.results[0]!.scenarioVersion = 1;
  expect(reportSchema.parse(copy).results[0]).toMatchObject({
    status: 'INCONCLUSIVE',
    reason: 'historical',
  });
});

it('rejects a saved green prefix of a larger planned suite', () => {
  const copy = structuredClone(report);
  copy.planned!.push('omitted-case');
  expect(reportSchema.safeParse(copy).success).toBe(false);
});
it('requires a rerun of v2 PASS under the checkpoint rules', () => {
  const copy = structuredClone(report);
  copy.reportVersion = 2;
  copy.results[0]!.scenarioVersion = 2;
  delete copy.planned;
  expect(reportSchema.parse(copy).results[0]).toMatchObject({
    status: 'INCONCLUSIVE',
    reason: 'historical',
  });
});

it('cannot certify a pre-commit rejection whose checkpoint already contains a committed effect', async () => {
  const { suite, t } = oneCase();
  t.fault = { kind: 'transient', failures: 1, maxRetries: 1 };
  t.expectResponses = ['tool-error', 'success'];
  const recovered = await runSuite(suite, options);
  expect(recovered.results[0]?.status).toBe('PASS');
  const row = recovered.results[0]!;
  row.events.find((e) => e.kind === 'before-retry')!.entry!.effects = 1;
  expect(reportSchema.safeParse(recovered).success).toBe(false);
});

it('validates freshness at each saved observation when the contract requires it', () => {
  const copy = structuredClone(report),
    row = copy.results[0]!;
  row.config.verify = { kind: 'file', maxAgeMs: 1000 };
  expect(reportSchema.safeParse(copy).success).toBe(false);
  for (const e of row.events.filter((e) => e.reading)) e.ageMs = 50;
  expect(reportSchema.safeParse(copy).success).toBe(false);
  copy.reportVersion = 4;
  row.scenarioVersion = 4;
  expect(reportSchema.safeParse(copy).success).toBe(true);
  row.events.at(-1)!.ageMs = 1001;
  expect(reportSchema.safeParse(copy).success).toBe(false);
});
