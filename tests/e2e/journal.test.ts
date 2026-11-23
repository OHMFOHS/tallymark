import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { it, expect } from 'vitest';
import { directory, example, oneCase } from '../helpers.js';
import { reportSchema } from '../../packages/core/evidence.js';

const cli = join(directory, 'dist/packages/cli/main.js');
async function setupCase(temp: string) {
  const ledger = join(temp, 'ledger.json');
  const { suite, t } = oneCase();
  suite.targets.ledger = {
    kind: 'stdio',
    command: process.execPath,
    args: [
      join(directory, 'tests/integration/review-server.mjs'),
      ledger,
      'hold-second-reply',
    ],
  };
  t.verify = { kind: 'file', path: ledger };
  t.requestTimeoutMs = 8000;
  await writeFile(ledger, JSON.stringify({ version: 1, operations: {} }));
  await writeFile(join(temp, 'suite.yaml'), JSON.stringify(suite));
  return ledger;
}
const args = [
  cli,
  'test',
  '-c',
  'suite.yaml',
  '--out',
  'out',
  '--allow-external',
  '--allow-stdio',
];
async function progress(temp: string) {
  const folders = await readdir(join(temp, 'out'));
  expect(folders).toHaveLength(1);
  expect(folders[0]).toMatch(/^pending-/);
  return join(temp, 'out', folders[0]!, 'progress.json');
}

it('reconciles both real backend commits after killing the runner before the second reply', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-active-'));
  try {
    const ledger = await setupCase(temp);
    const child = spawn(process.execPath, args, { cwd: temp, stdio: 'ignore' });
    const closed = once(child, 'exit');
    try {
      const end = Date.now() + 10000;
      while (!(await readFile(ledger, 'utf8')).includes('"effects":2')) {
        if (Date.now() >= end || child.exitCode !== null)
          throw new Error('Second commit was not observed.');
        await delay(20);
      }
      child.kill('SIGKILL');
      expect((await closed)[1]).toBe('SIGKILL');
      const path = await progress(temp);
      const before = await readFile(ledger, 'utf8');
      const off = spawnSync(
        process.execPath,
        [cli, 'journal', path, '--json'],
        { encoding: 'utf8' },
      );
      expect(off.status).toBe(3);
      const { active, completed } = JSON.parse(off.stdout);
      expect(completed).toEqual([]);
      expect(active).toMatchObject({
        caseId: 'lost-reply',
        tool: 'record_payment',
        ordinal: 2,
      });
      expect(JSON.parse(before).operations[active.operationKey]).toMatchObject({
        effects: 2,
        settledAttemptIds: active.possibleAttempts,
      });
      expect(await readFile(ledger, 'utf8')).toBe(before);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await closed;
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it.each([1, 2])(
  'stops before dispatch when the journal write fails at attempt %i',
  async (ordinal) => {
    const temp = await mkdtemp(join(tmpdir(), 'mrk-journal-io-'));
    try {
      const ledger = await setupCase(temp);
      const hook = join(temp, 'disk-error.mjs');
      await writeFile(
        hook,
        `import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      const rename = fs.rename.bind(fs);
      fs.rename = async (a,b) => {
        if (String(b).endsWith('/progress.json') && JSON.parse(await fs.readFile(a, 'utf8')).active?.ordinal === ${ordinal}) throw Error('disk full');
        return rename(a,b);
      };
      syncBuiltinESMExports();`,
      );
      const run = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(hook).href, ...args],
        { cwd: temp, encoding: 'utf8', timeout: 15000 },
      );
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('Could not save the pending attempt');
      const journal = JSON.parse(await readFile(await progress(temp), 'utf8'));
      const ops = JSON.parse(await readFile(ledger, 'utf8')).operations;
      if (ordinal === 1) {
        expect(journal.active).toBeNull();
        expect(ops).toEqual({});
      } else {
        expect(journal.active.ordinal).toBe(1);
        expect(ops[journal.active.operationKey].effects).toBe(1);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

it('reads older progress conservatively and rejects mismatched active cases and unknown versions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-journal-read-'));
  try {
    const path = join(temp, 'progress.json');
    const legacy = {
      complete: false,
      planned: ['work'],
      completed: [],
      seed: 1,
    };
    const read = () =>
      spawnSync(process.execPath, [cli, 'journal', path], { encoding: 'utf8' });
    await writeFile(path, JSON.stringify(legacy));
    expect(read()).toMatchObject({
      status: 3,
      stdout: expect.stringContaining('older journal'),
    });
    for (const extra of [
      { journalVersion: 2, active: null },
      {
        journalVersion: 1,
        active: {
          caseId: 'wrong',
          tool: 'act',
          operationKey: 'op-' + '0'.repeat(24),
          ordinal: 1,
        },
      },
    ]) {
      await writeFile(path, JSON.stringify({ ...legacy, ...extra }));
      expect(read().status).toBe(2);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it.each(['after-case', 'between-files'])(
  'retains an unreplayable progress journal after SIGKILL %s',
  async (at) => {
    const temp = await mkdtemp(join(tmpdir(), 'mrk-crash-report-'));
    try {
      const hook = join(temp, 'interrupt.mjs');
      // Terminate the real CLI at a filesystem boundary, after the underlying operation completes.
      await writeFile(
        hook,
        `
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.rename.bind(fs),write=fs.writeFile.bind(fs);
      fs.rename=async(a,b)=>{await rename(a,b);if('${at}'==='after-case' && String(b).endsWith('/progress.json') && JSON.parse(await fs.readFile(b,'utf8')).completed.length===1)process.kill(process.pid,'SIGKILL');};
      fs.writeFile=async(p,...args)=>{await write(p,...args);if('${at}'==='between-files' && String(p).endsWith('/final/report.json'))process.kill(process.pid,'SIGKILL');};
      syncBuiltinESMExports();
    `,
      );
      await writeFile(join(temp, 'suite.yaml'), example);
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(hook).href,
          join(directory, 'dist/packages/cli/main.js'),
          'test',
          '-c',
          'suite.yaml',
          '--out',
          'out',
        ],
        { cwd: temp, timeout: 15000 },
      );
      expect(child.signal).toBe('SIGKILL');
      const folders = await readdir(join(temp, 'out'));
      expect(folders).toHaveLength(1);
      expect(folders[0]).toMatch(/^pending-/);
      const journal = JSON.parse(
        await readFile(join(temp, 'out', folders[0]!, 'progress.json'), 'utf8'),
      );
      expect(journal.complete).toBe(false);
      expect(journal.planned).toHaveLength(4);
      expect(journal.completed).toHaveLength(at === 'after-case' ? 1 : 4);
      expect(reportSchema.safeParse(journal).success).toBe(false);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
