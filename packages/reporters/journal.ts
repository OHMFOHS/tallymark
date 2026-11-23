import { z } from 'zod';
import { attemptId } from '../contracts/attempt.js';
import { identifier, PublicError, readBounded } from '../contracts/index.js';
import { resultSchema } from '../core/evidence.js';

const fields = {
  complete: z.literal(false),
  seed: z.int().min(0).max(2147483647),
  planned: z.array(identifier).min(1).max(32),
  completed: z.array(resultSchema).max(32),
};
const activeSchema = z.strictObject({
  caseId: identifier,
  tool: identifier,
  operationKey: resultSchema.shape.operationKey,
  ordinal: z.int().min(1).max(4),
});
const progressSchema = z.union([
  z.strictObject({
    ...fields,
    journalVersion: z.literal(1),
    active: activeSchema.nullable(),
  }),
  z.strictObject(fields),
]);

export async function inspectJournal(path: string) {
  try {
    const data = progressSchema.parse(
      JSON.parse(await readBounded(path, 1024 * 1024)),
    );
    const { completed, planned } = data;
    const active = 'active' in data ? data.active : null;
    if (
      new Set(planned).size !== planned.length ||
      completed.some((r, i) => r.id !== planned[i]) ||
      (active && active.caseId !== planned[completed.length])
    )
      throw new Error();

    const possibleAttempts = active
      ? Array.from({ length: active.ordinal }, (_, i) =>
          attemptId(active.operationKey, i + 1),
        )
      : [];
    return {
      complete: false,
      seed: data.seed,
      planned,
      completed: completed.map(({ id, operationKey, invocationCount }) => ({
        id,
        operationKey,
        invocationCount,
      })),
      active: active ? { ...active, possibleAttempts } : null,
      guidance: !('active' in data)
        ? 'This older journal omitted in-flight attempts. Check backend records before a new run.'
        : active
          ? 'Match these possible attempts against committed effects and terminal records at the backend before a new run. A recorded intent alone cannot establish delivery.'
          : 'There is no pending dispatch recorded. Check completed case evidence and the matching run directory before a new run.',
    };
  } catch {
    throw new PublicError(
      'Invalid, unreadable or unsupported journal. Select progress.json from an interrupted run.',
    );
  }
}
