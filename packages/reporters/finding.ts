import { identifier, testSchema } from '../contracts/index.js';
import { reasons, type Result } from '../core/evidence.js';
import { allSettled } from '../core/ledger.js';

const remedies: Record<Result['reason'], string> = {
  verified: 'Keep this contract and exporter in CI for future changes.',
  invariant:
    'Reconcile the observed records with the operation key and inspect the commit boundary.',
  precommit:
    'Move rejection before the transaction commits, or revise the declared failure boundary.',
  responses:
    'Compare the response sequence with the original contract and inspect the server handler.',
  observed:
    'For a safety verdict, export committed effects and terminal attempt IDs from the authoritative store.',
  observerRequired:
    'Choose explicit observational mode for response testing, or configure a file observer.',
  baselineUnavailable:
    'Initialize a complete, readable export before dispatch. Check publishedAt when a maximum age is configured.',
  unknown:
    'Reconcile pending jobs and export one terminal ID per completed attempt alongside committed effects.',
  inconsistent:
    'Publish complete snapshots atomically from a monotonic history of committed effects and terminal IDs.',
  retryEvidence:
    'Export earlier terminal IDs before dispatching another attempt. Use after-settlement for verified tests.',
  retryBlocked:
    'Inspect the original attempt at the downstream boundary and reconcile its status before another call.',
  firstEffect:
    'Check the original commit and export its terminal attempt ID before testing response loss again.',
  historical:
    'Inspect the historical observations and validate the original contract on a new isolated target.',
  transport:
    'Reconcile the operation key in the backend before authorizing another invocation.',
  dirty:
    'Use an isolated test store and check existing records for the operation key.',
  denied:
    'Review the tool and its effects. Authorize only an intended disposable test case.',
  permission:
    'Review the target, then supply its exact URL or the explicit stdio launch permissions.',
  fixtureOnly:
    'Use the bundled fixture for injected transient errors, or select a supported external schedule.',
  arguments:
    'Compare the contract arguments with the schema advertised by the selected tool.',
  taskRequired:
    'Choose a tool that completes without task-augmented execution.',
  missing:
    'Run doctor or list and select a tool the server currently advertises.',
  connection:
    'Run doctor against the same endpoint or reviewed stdio executable.',
  deadline:
    'Inspect the progress journal and reconcile any dispatched operation at its authoritative store.',
  cleanup:
    'Inspect the isolated process and state directory before starting a fresh experiment.',
  internal:
    'Retain the redacted journal, isolate the target and compare with the bundled fixture.',
  cancellationUnknown:
    'Export server-side cancellation telemetry and the final effect history for this operation.',
  cancellation:
    'Check cancellation delivery and handling independently from committed effects.',
};

// Derive display fields from bounded evidence. Stored explanations and free-form
// config values are never interpreted as markup, shell arguments or policy.
export function finding(r: Result, seed: number) {
  const tool = identifier.safeParse(r.config.tool).data ?? 'unrecorded';
  const scenario =
    testSchema.shape.fault.safeParse(r.config.fault).data?.kind ?? 'unrecorded';
  const invariant =
    testSchema.shape.invariant.safeParse(r.config.invariant).data ?? null;
  const expectedReplies =
    testSchema.shape.expectResponses.safeParse(r.config.expectResponses).data ??
    [];
  const replies = r.events.flatMap((e) =>
    (e.kind === 'reply' || e.kind === 'reply-withheld') && e.response
      ? [e.response]
      : [],
  );
  const evidence = r.events.filter((e) => e.reading !== undefined);
  const final = evidence.find((e) => e.kind === 'state');
  const counts = evidence.flatMap((e) =>
    e.reading === 'present' && e.entry ? [e.entry.effects] : [],
  );
  const highestObservedEffects = counts.length ? Math.max(...counts) : null;
  const excess =
    r.status === 'FAIL' &&
    r.reason === 'invariant' &&
    invariant &&
    highestObservedEffects !== null &&
    highestObservedEffects > invariant.maxEffects;
  const hasTerminalIds =
    r.invocationCount > 0 &&
    final?.reading === 'present' &&
    allSettled(final.entry, r.operationKey, r.invocationCount);
  const mode =
    r.config.mode === 'observational' || r.config.mode === 'verified'
      ? r.config.mode
      : 'unrecorded';
  const severity =
    r.status === 'FAIL'
      ? excess || r.reason === 'precommit'
        ? 'high'
        : 'medium'
      : r.status === 'PASS'
        ? 'none'
        : 'unassessed';
  let uncertainty: string | null = null;
  if (
    r.status === 'INCONCLUSIVE' ||
    r.status === 'SKIPPED' ||
    r.status === 'ERROR'
  )
    uncertainty = reasons[r.reason];
  else if (!hasTerminalIds)
    uncertainty =
      'The final terminal ID set is unconfirmed. Additional work may still complete.';
  const transport = (r.config.transport as { kind?: unknown } | null)?.kind;
  const flags =
    transport === 'stdio'
      ? ' --allow-external --allow-stdio'
      : transport === 'http'
        ? ' --allow-external --allow-url "$MCP_URL"'
        : '';
  return {
    version: 1,
    caseId: r.id,
    tool,
    scenario,
    mode,
    status: r.status,
    severity,
    conclusion: excess
      ? `${highestObservedEffects} committed effects observed for one logical operation. The declared maximum is ${invariant.maxEffects}.`
      : reasons[r.reason],
    expected: { invariant, responses: expectedReplies },
    observed: {
      calls: r.invocationCount,
      responses: replies,
      highestObservedEffects,
      completeTerminalSet: !!hasTerminalIds,
    },
    evidenceEvents: evidence.map((e) => e.seq),
    uncertainty,
    remediation: excess
      ? 'If repeats must collapse, enforce uniqueness on the operation key in the transaction that commits the effect. Reconcile existing effects first.'
      : remedies[r.reason],
    reproduction: {
      replay: 'mcp-reliability-kit report "$REPORT_JSON"',
      isolatedRun: `mcp-reliability-kit test -c "$SUITE" --case ${r.id}${flags}`,
      conditions: `Restore the original suite inputs and use seed ${seed} on a fresh isolated target. Reconcile pending effects before authorizing a live run.`,
    },
  };
}
