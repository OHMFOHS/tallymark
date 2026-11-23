// Exercise the distributable from a consumer directory with no checkout imports.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npmInstall = process.argv.includes('--npm');
const artifacts = resolve(
  process.argv.slice(2).find((arg) => arg !== '--npm') ?? 'artifacts/pack',
);
mkdirSync(artifacts, { recursive: true });
const archive = join(artifacts, `${manifest.name}-${manifest.version}.tgz`);
const checksum = archive + '.sha256';
rmSync(checksum, { force: true });
execFileSync('pnpm', ['pack', '--pack-destination', artifacts], {
  stdio: 'inherit',
});
const digest = () =>
  createHash('sha256').update(readFileSync(archive)).digest('hex');
const testedDigest = digest();
const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .map((f) => f.replace(/^package\//, ''));
assert.deepEqual(
  files.sort(),
  [...manifest.files, 'README.md', 'package.json'].sort(),
);
const consumer = mkdtempSync(join(tmpdir(), 'mrk-pack-'));
try {
  writeFileSync(join(consumer, 'package.json'), '{"private":true}');
  const installer = npmInstall ? 'npm' : 'pnpm';
  const args = npmInstall
    ? [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        join(consumer, 'cache'),
        archive,
      ]
    : ['add', '--offline', '--ignore-scripts', archive];
  const installStarted = performance.now();
  execFileSync(installer, args, {
    cwd: consumer,
    stdio: 'inherit',
  });
  const bin = join(consumer, 'node_modules', '.bin', 'mcp-reliability-kit');
  function run(args, expected) {
    const r = spawnSync(bin, args, {
      cwd: consumer,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(
      r.status,
      expected,
      JSON.stringify([args, r.stdout, r.stderr, r.error]),
    );
    return r.stdout;
  }
  const installMs = Math.round(performance.now() - installStarted);
  const doctorStarted = performance.now();
  const diagnosis = JSON.parse(run(['doctor', '--json'], 0));
  const doctorMs = Math.round(performance.now() - doctorStarted);
  assert.equal(diagnosis.safety, 'unassessed');
  assert.equal(diagnosis.toolCalls, 0);
  assert.ok(diagnosis.tools.some((t) => t.name === 'record_payment'));
  writeFileSync(
    join(artifacts, `timing-${installer}.json`),
    JSON.stringify(
      {
        version: manifest.version,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        installer,
        freshRegistryCache: npmInstall,
        fixture: 'bundled stdio',
        installMs,
        doctorMs,
        installToFirstDiagnosticMs: Math.round(
          performance.now() - installStarted,
        ),
      },
      null,
      2,
    ) + '\n',
  );
  assert.equal(run(['--version'], 0).trim(), manifest.version);
  run(
    [
      'init',
      '-c',
      'http.yaml',
      '--url',
      'http://127.0.0.1:1/mcp',
      '--tool',
      'read_counter',
    ],
    0,
  );
  assert.match(
    run(['test', '-c', 'http.yaml', '--out', 'http-out'], 3),
    /SKIPPED\s+observe-tool\s+calls=0/,
  );
  writeFileSync(
    join(consumer, 'progress.json'),
    JSON.stringify({
      journalVersion: 1,
      complete: false,
      seed: 1,
      planned: ['observe-tool'],
      completed: [],
      active: {
        caseId: 'observe-tool',
        tool: 'read_counter',
        operationKey: 'op-' + 'a'.repeat(24),
        ordinal: 2,
      },
    }),
  );
  const pending = JSON.parse(run(['journal', 'progress.json', '--json'], 3));
  assert.equal(
    pending.active.possibleAttempts[1],
    'op-' + 'a'.repeat(24) + '.2',
  );
  run(['init'], 0);
  assert.match(run(['list'], 0), /record_payment/);
  run(['init', '-c', 'unsafe.yaml', '--fixture', 'unsafe'], 0);
  run(['init', '--example', 'filesystem', '-c', 'observe.yaml'], 0);
  const original = readFileSync(join(consumer, 'reliability.yaml'), 'utf8');
  writeFileSync(
    join(consumer, 'skipped.yaml'),
    original.replaceAll('allowSideEffects: true', 'allowSideEffects: false'),
  );
  writeFileSync(
    join(consumer, 'error.yaml'),
    original.replaceAll('tool: record_payment', 'tool: unavailable_tool'),
  );
  for (const [name, config, code] of [
    ['safe', 'reliability.yaml', 0],
    ['skipped', 'skipped.yaml', 3],
    ['error', 'error.yaml', 2],
    ['unsafe', 'unsafe.yaml', 1],
    [
      'unknown',
      'node_modules/mcp-reliability-kit/examples/inconclusive.yaml',
      3,
    ],
  ]) {
    const output = run(['test', '-c', config, '--out', name], code);
    const [directory] = readdirSync(join(consumer, name));
    const report = join(consumer, name, directory, 'report.json');
    assert.ok(output.startsWith(run(['report', report], code).trim()));
    assert.ok(
      readFileSync(
        join(consumer, name, directory, 'junit.xml'),
        'utf8',
      ).includes('<testsuite'),
    );
  }
  const workflow = parse(
    readFileSync(
      join(
        consumer,
        'node_modules/mcp-reliability-kit/examples/ci/verified.yml',
      ),
      'utf8',
    ),
  );
  const gate = workflow.jobs.gate.steps.find(
    (step) => step.name === 'Verify the declared contract',
  ).run;
  for (const [file, code, label] of [
    ['', 0, 'PASS'],
    ['unsafe.yaml', 1, 'FAIL'],
    ['skipped.yaml', 3, 'SKIPPED'],
    ['error.yaml', 2, 'ERROR'],
    [
      'node_modules/mcp-reliability-kit/examples/inconclusive.yaml',
      3,
      'INCONCLUSIVE',
    ],
  ]) {
    const summaryFile = join(consumer, 'summary-' + label);
    const out = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', gate], {
      cwd: consumer,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        SUITE: file,
        MCP_URL: '',
        ALLOW_STDIO: '',
        RUNNER_TEMP: consumer,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    });
    assert.equal(out.status, code, out.stdout + out.stderr);
    assert.ok(readFileSync(summaryFile, 'utf8').includes(label));
  }
  console.log(
    'Consumer workflow shell preserved all five verdicts and wrote job summaries.',
  );
  console.log(
    'Packed consumer verified. Archive inventory, CLI, JSON replay and all five statuses and exits 0/1/2/3 passed.',
  );
  assert.equal(digest(), testedDigest);
  writeFileSync(checksum, testedDigest + '  ' + basename(archive) + '\n');
  console.log('Verified archive SHA-256: ' + testedDigest);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
