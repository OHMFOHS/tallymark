import { z } from 'zod';
import {
  identifier,
  responseSchema,
  testSchema,
  exercisesFault,
} from '../contracts/index.js';
import { entrySchema } from './ledger.js';
import { attemptId } from '../contracts/attempt.js';
import { assess } from './verdict.js';
import { isDeepStrictEqual } from 'node:util';

export const reasons = {
  baselineUnavailable:
    'No complete baseline was readable. Initialize the observer file and publish a complete snapshot before running this case.',
  observerRequired:
    'No call was issued. Select mode: observational to collect replies, or configure an independent observer for verified testing.',
  observed:
    'The response sequence was observed. Verified safety requires an independent effect count and terminal attempt IDs.',
  retryEvidence:
    'The observer could not establish that the prior attempts had settled before each retry.',
  retryBlocked:
    'Retry withheld because prior settlement could not be established within the observation window.',
  inconsistent:
    'The observer retracted committed effects, settlement IDs or cancellation evidence. Check the exporter.',
  precommit:
    'The observer recorded a committed effect during a declared pre-commit failure.',
  verified: 'Response sequence and settled effect count satisfy the contract.',
  invariant: 'The observed committed effects violate the declared range.',
  firstEffect:
    'The observer could not establish a committed first attempt before the retry.',
  historical:
    'This historical pass requires a rerun under the current evidence rules.',
  responses: 'The observed response sequence differs from the contract.',
  unknown:
    'Authoritative state is unavailable or does not account for every attempt.',
  transport:
    'A call ended without a classifiable SDK result. No further call was issued.',
  dirty:
    'The operation key already exists. Use a fresh seed or isolate the ledger.',
  denied: 'Set allowSideEffects to true to authorize this case.',
  permission:
    'External targets require --allow-external plus --allow-stdio for executables or an exact --allow-url for HTTP.',
  fixtureOnly: 'Transient fault injection requires a bundled fixture.',
  arguments:
    'The resolved arguments could not be validated against the advertised tool input schema.',
  taskRequired:
    'The tool requires task-augmented execution, which this runner does not support.',
  missing: 'The target did not advertise the selected tool.',
  connection:
    'MCP connection or discovery failed. Check the target, protocol and timeout.',
  deadline: 'The case or suite deadline expired, or the run was interrupted.',
  cleanup: 'Resource cleanup failed. Inspect the fixture environment.',
  internal: 'The runner could not complete the case.',
  cancellationUnknown: 'Server-side cancellation telemetry is unavailable.',
  cancellation:
    'The settled operation did not record the expected server-side cancellation.',
};
const statuses = ['PASS', 'FAIL', 'INCONCLUSIVE', 'SKIPPED', 'ERROR'] as const;
export type Status = (typeof statuses)[number];
const observedSchema = z.enum([...responseSchema.options, 'unknown']);
const eventSchema = z.object({
  seq: z.int().positive(),
  kind: z.enum([
    'connected',
    'baseline',
    'invoke',
    'reply',
    'reply-withheld',
    'before-retry',
    'state',
  ]),
  attempt: z.int().nonnegative().optional(),
  attemptId: z
    .string()
    .regex(/^op-[a-f0-9]{24}\.[1-4]$/)
    .optional(),
  response: observedSchema.optional(),
  reading: z
    .enum(['unavailable', 'absent', 'present', 'inconsistent'])
    .optional(),
  entry: entrySchema.optional(),
  ageMs: z.int().nonnegative().optional(),
});
const assertionSchema = z.object({
  name: z.enum([
    'responses',
    'settlement',
    'effects',
    'cancellation',
    'firstEffect',
    'retrySettlement',
  ]),
  expected: z.union([z.string(), z.number()]),
  actual: z.union([z.string(), z.number(), z.null()]),
  verdict: z.enum(['met', 'violated', 'unknown']),
});
const versionSchema = z.literal([1, 2, 3, 4]);
export const resultSchema = z.object({
  id: identifier,
  scenarioVersion: versionSchema,
  operationKey: z.string().regex(/^op-[a-f0-9]{24}$/),
  protocolVersion: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  invocationCount: z.int().min(0).max(4),
  status: z.enum(statuses),
  reason: z.enum(
    Object.keys(reasons) as [keyof typeof reasons, ...(keyof typeof reasons)[]],
  ),
  events: z.array(eventSchema).max(32),
  assertions: z.array(assertionSchema).max(6),
  // This is an allowlisted projection of the contract made by the runner.
  config: z.record(z.string(), z.unknown()),
});
const envelope = z.object({
  reportVersion: versionSchema,
  contractVersion: z.literal(1),
  planned: z.array(identifier).min(1).max(32).optional(),
  seed: z.int().nonnegative(),
  results: z.array(resultSchema).min(1).max(32),
});
export type Result = z.infer<typeof resultSchema>;
export type Report = z.infer<typeof envelope>;
export type Observation = z.infer<typeof observedSchema>;
export type Event = z.infer<typeof eventSchema>;

const policySchema = testSchema
  .pick({
    id: true,
    tool: true,
    target: true,
    fault: true,
    expectResponses: true,
    invariant: true,
    allowSideEffects: true,
    requestTimeoutMs: true,
    settleTimeoutMs: true,
  })
  .extend({
    mode: z.literal('verified'),
    retryPolicy: z.enum(['after-settlement', 'scheduled']),
    arguments: z.literal('[redacted]'),
    verify: z.object({
      kind: z.enum(['file', 'fixture']),
      maxAgeMs: z.int().min(1).max(86400000).optional(),
    }),
    transport: z.object({ kind: z.enum(['fixture', 'stdio', 'http']) }),
  });

// Recompute a green verdict from its ordered observations. A local report is
// still an unsigned artifact. Consistency checking does not authenticate it.
function supportedPass(r: Result): boolean {
  const parsed = policySchema.safeParse(r.config);
  if (
    !parsed.success ||
    !r.protocolVersion ||
    r.reason !== 'verified' ||
    r.invocationCount < 1
  )
    return false;
  const t = parsed.data;
  if (
    !exercisesFault(t) ||
    t.id !== r.id ||
    !t.allowSideEffects ||
    t.invariant.minEffects > t.invariant.maxEffects ||
    (t.verify.kind === 'fixture' && t.transport.kind !== 'fixture') ||
    (t.fault.kind === 'transient' && t.transport.kind !== 'fixture')
  )
    return false;
  const limit = t.verify.maxAgeMs;
  if (
    limit !== undefined &&
    (r.scenarioVersion < 4 ||
      t.verify.kind !== 'file' ||
      r.events.some(
        (e) =>
          ['baseline', 'before-retry', 'state'].includes(e.kind) &&
          (e.ageMs === undefined || e.ageMs > limit),
      ))
  )
    return false;
  const f = t.fault;
  const calls =
    f.kind === 'timeout' || f.kind === 'none'
      ? 1
      : f.kind === 'transient'
        ? Math.min(f.maxRetries, f.failures) + 1
        : 1 + f.maxRetries;
  if (r.invocationCount !== calls || t.expectResponses.length !== calls)
    return false;
  if (r.events.some((e, i) => e.seq !== i + 1)) return false;
  const [connection, baseline] = r.events;
  if (
    connection?.kind !== 'connected' ||
    baseline?.kind !== 'baseline' ||
    baseline.reading !== 'absent' ||
    baseline.entry
  )
    return false;
  let cursor = 2;
  for (let i = 1; i <= calls; i++) {
    const dispatch = r.events[cursor++];
    const reply = r.events[cursor++];
    const withheld = f.kind === 'lost-response' && i === 1;
    if (
      dispatch?.kind !== 'invoke' ||
      dispatch.attempt !== i ||
      dispatch.attemptId !== attemptId(r.operationKey, i) ||
      reply?.kind !== (withheld ? 'reply-withheld' : 'reply') ||
      reply.attempt !== i ||
      reply.response !== t.expectResponses[i - 1] ||
      withheld !== (reply.response === 'lost')
    )
      return false;
    if (i < calls && r.events[cursor++]?.kind !== 'before-retry') return false;
  }
  const final = r.events[cursor];
  if (
    cursor + 1 !== r.events.length ||
    final?.kind !== 'state' ||
    final.reading !== 'present' ||
    !final.entry
  )
    return false;
  const decision = assess(t, r);
  return (
    decision.status === 'PASS' &&
    isDeepStrictEqual(r.assertions, decision.assertions)
  );
}

export const reportSchema = envelope
  .superRefine((report, ctx) => {
    if (
      report.reportVersion >= 3 &&
      !isDeepStrictEqual(
        report.planned,
        report.results.map((r) => r.id),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Incomplete suite or incorrect case order.',
      });
    if (new Set(report.results.map((r) => r.id)).size !== report.results.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate test IDs.' });
    for (const r of report.results) {
      if (
        r.scenarioVersion !== report.reportVersion ||
        (report.reportVersion >= 3 && r.status === 'PASS' && !supportedPass(r))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Verdict and evidence disagree.',
        });
    }
  })
  .transform((report) => {
    if (report.reportVersion < 3)
      for (const r of report.results)
        if (r.status === 'PASS') {
          r.status = 'INCONCLUSIVE';
          r.reason = 'historical';
        }
    return report;
  });
