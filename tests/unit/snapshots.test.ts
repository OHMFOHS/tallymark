import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import {
  readEntry,
  trackReadings,
  type Entry,
} from '../../packages/core/ledger.js';
const key = 'op-' + '0'.repeat(24);
const first: Entry = {
  effects: 1,
  settledAttempts: 1,
  settledAttemptIds: [key + '.1'],
  cancellations: 1,
};
it.each([
  null,
  { ...first, effects: 0 },
  { ...first, settledAttempts: 0 },
  { ...first, settledAttemptIds: [key + '.2'] },
  { ...first, cancellations: 0 },
])(
  'remembers contradictory exports across polling even after the original data returns (%j)',
  async (later) => {
    const snapshots = [first, later, first];
    const read = trackReadings(async () => ({
      available: true,
      entry: snapshots.shift()!,
    }));
    expect((await read()).available).toBe(true);
    for (let i = 0; i < 2; i++)
      expect(await read()).toEqual({ available: false, inconsistent: true });
  },
);
it('rejects a partial snapshot even when the included row claims exact settlement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrk-partial-'));
  try {
    const file = join(dir, 'ledger.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        complete: false,
        operations: { [key]: first },
      }),
    );
    expect(await readEntry(file, key)).toEqual({ available: false });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        complete: true,
        operations: { [key]: first },
      }),
    );
    expect(await readEntry(file, key)).toEqual({
      available: true,
      entry: first,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('requires a valid recent publication time only when a maximum age is set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrk-fresh-'));
  const file = join(dir, 'ledger.json');
  try {
    for (const publishedAt of [
      undefined,
      '2000-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
    ]) {
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          publishedAt,
          operations: { [key]: first },
        }),
      );
      expect(await readEntry(file, key, false, 5000)).toEqual({
        available: false,
      });
      expect((await readEntry(file, key)).available).toBe(true);
    }
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        publishedAt: new Date().toISOString(),
        operations: { [key]: first },
      }),
    );
    expect(await readEntry(file, key, false, 5000)).toMatchObject({
      available: true,
      entry: first,
      ageMs: expect.any(Number),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
