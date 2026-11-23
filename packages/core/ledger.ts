import { attemptId } from '../contracts/attempt.js';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { readBounded } from '../contracts/index.js';

export const entrySchema = z.object({
  effects: z.int().nonnegative(),
  settledAttempts: z.int().nonnegative(),
  settledAttemptIds: z
    .array(z.string().regex(/^op-[a-f0-9]{24}\.[1-4]$/))
    .max(64)
    .optional(),
  cancellations: z.int().nonnegative().optional(),
});
export type Entry = z.infer<typeof entrySchema>;
const snapshotSchema = z.object({
  version: z.literal(1),
  complete: z.boolean().optional(),
  publishedAt: z.iso.datetime().optional(),
  operations: z.record(z.string(), entrySchema),
});
const fixtureSnapshotSchema = z.object({
  version: z.literal(1),
  operations: z.record(
    z.string(),
    entrySchema.extend({ receipts: z.array(z.int().positive()) }),
  ),
});
export type Reading =
  | { available: true; entry: Entry | null; ageMs?: number }
  | { available: false; inconsistent?: true };

export async function readEntry(
  path: string | undefined,
  key: string,
  fixture = false,
  maxAgeMs?: number,
): Promise<Reading> {
  if (!path) return { available: false };
  try {
    const raw: unknown = JSON.parse(await readBounded(path, 256 * 1024));
    if (fixture) {
      const { operations } = fixtureSnapshotSchema.parse(raw);
      const row = operations[key];
      // Count the committed receipt rows independently of the server's counter.
      return {
        available: true,
        entry: row
          ? {
              effects: row.receipts.length,
              settledAttempts: row.settledAttempts,
              cancellations: row.cancellations,
              settledAttemptIds: row.settledAttemptIds,
            }
          : null,
      };
    }
    const snapshot = snapshotSchema.parse(raw);
    if (snapshot.complete === false) return { available: false };
    const ageMs = snapshot.publishedAt
      ? Date.now() - Date.parse(snapshot.publishedAt)
      : undefined;
    if (
      maxAgeMs !== undefined &&
      (ageMs === undefined || ageMs < 0 || ageMs > maxAgeMs)
    )
      return { available: false };
    return {
      available: true,
      ...(maxAgeMs !== undefined ? { ageMs } : {}),
      entry: Object.hasOwn(snapshot.operations, key)
        ? snapshot.operations[key]!
        : null,
    };
  } catch {
    return { available: false };
  }
}

export function allSettled(
  entry: Entry | null | undefined,
  key: string,
  calls: number,
) {
  const ids = entry?.settledAttemptIds;
  return (
    calls > 0 &&
    entry?.settledAttempts === calls &&
    ids?.length === calls &&
    Array.from({ length: calls }, (_, i) => attemptId(key, i + 1)).every((id) =>
      ids.includes(id),
    )
  );
}

// A later export may add effects and terminal IDs, but cannot retract them.
export function regresses(previous: Entry, next: Entry | null) {
  return (
    !next ||
    next.effects < previous.effects ||
    next.settledAttempts < previous.settledAttempts ||
    (previous.cancellations !== undefined &&
      (next.cancellations ?? -1) < previous.cancellations) ||
    (previous.settledAttemptIds ?? []).some(
      (id) => !next.settledAttemptIds?.includes(id),
    )
  );
}

export function trackReadings(read: () => Promise<Reading>) {
  let prior: Entry | null = null;
  let inconsistent = false;
  return async (): Promise<Reading> => {
    const state = await read();
    if (state.available) {
      if (prior && regresses(prior, state.entry)) inconsistent = true;
      prior = state.entry;
    }
    return inconsistent ? { available: false, inconsistent: true } : state;
  };
}

export async function awaitSettlement(
  path: string | undefined,
  key: string,
  attempts: number,
  ms: number,
  signal: AbortSignal,
  fixture = false,
  maxEffects = Infinity,
  read = () => readEntry(path, key, fixture),
): Promise<Reading> {
  const end = performance.now() + ms;
  for (;;) {
    signal.throwIfAborted();
    const state = await read();
    if (
      !path ||
      (!state.available && state.inconsistent) ||
      (state.available &&
        state.entry &&
        (allSettled(state.entry, key, attempts) ||
          state.entry.effects > maxEffects)) ||
      performance.now() >= end
    )
      return state;
    await delay(Math.max(1, Math.min(20, end - performance.now())), undefined, {
      signal,
    });
  }
}
