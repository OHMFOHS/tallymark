import { finding } from './finding.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reasons, type Report } from '../core/evidence.js';
import type { PendingAttempt } from '../contracts/attempt.js';

export function exitCode(report: Report) {
  const has = (status: string) =>
    report.results.some((r) => r.status === status);
  if (has('ERROR')) return 2;
  if (has('FAIL')) return 1;
  return has('INCONCLUSIVE') || has('SKIPPED') ? 3 : 0;
}
export function summary(report: Report): string {
  return [
    `Execution-safety suite (seed ${report.seed})`,
    ...report.results.map((r) => {
      const info = finding(r, report.seed);
      const line = `${r.status.padEnd(12)} ${r.id}  calls=${r.invocationCount} effects=${info.observed.highestObservedEffects ?? '?'}`;
      const bounds = info.expected.invariant;
      return [
        line,
        `  ${info.tool} · ${info.scenario} · ${info.mode} · severity ${info.severity}`,
        `  ${info.conclusion}`,
        `  Expected effects ${bounds ? bounds.minEffects + '..' + bounds.maxEffects : 'unrecorded'}; replies ${info.expected.responses.join(', ') || 'unrecorded'}. Observed replies: ${info.observed.responses.join(', ') || 'none'}.`,
        `  Evidence: ${r.operationKey}, state events ${info.evidenceEvents.join(', ') || 'none'}, complete terminal set ${info.observed.completeTerminalSet ? 'observed' : 'unconfirmed'}.`,
        ...(info.uncertainty && info.uncertainty !== info.conclusion
          ? ['  Uncertainty: ' + info.uncertainty]
          : []),
        '  Next: ' + info.remediation,
        '  Replay: ' + info.reproduction.replay,
        '  Isolated reproduction: ' + info.reproduction.isolatedRun,
      ].join('\n');
    }),
  ].join('\n');
}
function xml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
export function junit(report: Report) {
  const rs = report.results;
  const count = (s: string) => rs.filter((r) => r.status === s).length;
  const cases = rs.map((r) => {
    const lines = [
      `  <testcase classname="mcp.reliability" name="${xml(r.id)}">`,
    ];
    if (r.status !== 'PASS') {
      const tag =
        r.status === 'FAIL'
          ? 'failure'
          : r.status === 'ERROR'
            ? 'error'
            : 'skipped';
      lines.push(
        `    <${tag} type="${r.status}" message="${xml(reasons[r.reason])}">${xml(JSON.stringify(r.assertions))}</${tag}>`,
      );
    }
    lines.push(
      `    <system-out>${xml(JSON.stringify({ status: r.status, protocol: r.protocolVersion, calls: r.invocationCount, events: r.events }))}</system-out>`,
      '  </testcase>',
    );
    return lines.join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="mcp-reliability-kit" tests="${rs.length}" failures="${count('FAIL')}" errors="${count('ERROR')}" skipped="${count('SKIPPED') + count('INCONCLUSIVE')}">`,
    ...cases,
    '</testsuite>',
    '',
  ].join('\n');
}
// A journal is intentionally outside the final report schema. Its initial
// record reaches disk before any target is launched.
export async function startRun(
  parent: string,
  seed: number,
  planned: string[],
) {
  await mkdir(parent, { recursive: true });
  const id = randomUUID();
  const pending = join(parent, 'pending-' + id);
  const out = join(parent, 'run-' + id);
  await mkdir(pending, { mode: 0o700 });
  const path = join(pending, 'progress.json');
  let completed: Report['results'] = [];
  async function writeProgress(active: PendingAttempt | null) {
    const next = join(pending, 'progress.next');
    await writeFile(
      next,
      JSON.stringify({
        journalVersion: 1,
        complete: false,
        seed,
        planned,
        completed,
        active,
      }) + '\n',
      { mode: 0o600, flush: true },
    );
    await rename(next, path);
  }
  async function checkpoint(report: Pick<Report, 'results'>) {
    completed = [...report.results];
    await writeProgress(null);
  }
  await writeProgress(null);
  return {
    path,
    beforeInvoke: writeProgress,
    checkpoint,
    async publish(report: Report) {
      if (
        report.results.length !== planned.length ||
        report.results.some((r, i) => r.id !== planned[i])
      )
        throw new Error('Cannot publish an incomplete suite.');
      const pair = join(pending, 'final');
      await mkdir(pair, { mode: 0o700 });
      await writeFile(
        join(pair, 'report.json'),
        JSON.stringify(
          {
            ...report,
            findings: report.results.map((r) => finding(r, report.seed)),
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600, flush: true },
      );
      await writeFile(join(pair, 'junit.xml'), junit(report), {
        mode: 0o600,
        flush: true,
      });
      await rename(pair, out);
      await rm(pending, { recursive: true, force: true });
      return out;
    },
  };
}

export async function saveReport(parent: string, report: Report) {
  const run = await startRun(
    parent,
    report.seed,
    report.results.map((r) => r.id),
  );
  await run.checkpoint(report);
  return run.publish(report);
}
