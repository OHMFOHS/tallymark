import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  access,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { directory, oneCase } from '../helpers.js';
import { reportSchema } from '../../packages/core/evidence.js';

it('runs the public commands and replays a saved failing report', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-cli-test-'));
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(directory, 'dist/packages/cli/main.js'), ...args],
      { cwd: temp, encoding: 'utf8', timeout: 15000 },
    );
  try {
    expect(cli('--help').stdout).toContain('report');
    expect(cli('init', '--fixture', 'unsafe').status).toBe(0);
    expect(cli('init').status).toBe(2);
    expect(cli('list').stdout).toContain('Protocol 2026-07-28\nrecord_payment');
    const run = cli('test', '--out', 'output');
    expect(run.status).toBe(1);
    const [folder] = await readdir(join(temp, 'output'));
    const reportFile = join(temp, 'output', folder!, 'report.json');
    const report = reportSchema.parse(
      JSON.parse(await readFile(reportFile, 'utf8')),
    );
    expect(report.results.map((r) => r.status)).toEqual([
      'FAIL',
      'FAIL',
      'PASS',
      'PASS',
    ]);
    const replay = cli('report', reportFile);
    expect(replay.status).toBe(1);
    expect(run.stdout.startsWith(replay.stdout.trim())).toBe(true);
    const xml = await readFile(
      join(temp, 'output', folder!, 'junit.xml'),
      'utf8',
    );
    expect(xml).toContain('tests="4" failures="2" errors="0" skipped="0"');
    expect(cli('test', '--unknown-flag').status).toBe(2);
    await writeFile(join(temp, 'broken.yaml'), 'version: [');
    expect(cli('test', '-c', 'broken.yaml').stderr).toContain('Invalid YAML');
    expect(cli('report', 'broken.yaml').status).toBe(2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it('does not start the configured command when permission is missing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-gate-'));
  try {
    const { suite, t } = oneCase();
    t.verify = { kind: 'none' };
    suite.targets.ledger = {
      kind: 'stdio',
      command: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('started','yes')"],
    };
    await writeFile(join(temp, 'test.yaml'), JSON.stringify(suite));
    for (const cmd of ['list', 'test']) {
      const run = spawnSync(
        process.execPath,
        [join(directory, 'dist/packages/cli/main.js'), cmd, '-c', 'test.yaml'],
        { cwd: temp, encoding: 'utf8' },
      );
      expect(run.status).toBe(2);
      expect(run.stdout + run.stderr).toContain('--allow-external');
    }
    await expect(access(join(temp, 'started'))).rejects.toThrow();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it('packages only named release files when a checkout contains local data and stale build outputs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mrk-inventory-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await writeFile(
      join(temp, 'package.json'),
      await readFile(join(directory, 'package.json')),
    );
    for (const parent of ['examples', 'docs', 'dist/packages/cli'])
      await mkdir(join(temp, parent), { recursive: true });
    for (const file of [
      'examples/local-run.json',
      'docs/private-notes.md',
      'dist/packages/cli/obsolete.js',
      'dist/packages/cli/main.js',
    ])
      await writeFile(join(temp, file), 'synthetic pack inventory marker');
    const pack = spawnSync(
      'npm',
      [
        'pack',
        '--dry-run',
        '--json',
        '--ignore-scripts',
        '--cache',
        join(temp, 'cache'),
      ],
      { cwd: temp, encoding: 'utf8', timeout: 10000 },
    );
    expect(pack.status).toBe(0);
    const inventory = JSON.parse(pack.stdout)[0].files.map(
      (f: { path: string }) => f.path,
    );
    expect(inventory.sort()).toEqual([
      'dist/packages/cli/main.js',
      'package.json',
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
