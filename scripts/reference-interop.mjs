// Run from the checkout. All state belongs to the temporary directory below.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const deps = join(root, 'integrations/reference');
const cli = join(root, 'dist/packages/cli/main.js');
const upstream = (name) =>
  join(
    deps,
    'node_modules/@modelcontextprotocol',
    'server-' + name,
    'dist/index.js',
  );
const gitServer = join(deps, '.venv/bin/mcp-server-git');
assert.ok(
  Number(process.versions.node.split('.')[0]) >= 24,
  'Run the reference servers with Node 24+.',
);
for (const file of [cli, upstream('filesystem'), upstream('memory'), gitServer])
  assert.ok(
    existsSync(file),
    'Build the CLI and install the locked reference dependencies first.',
  );
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'mrk-reference-')));
const output = join(root, 'artifacts/reference', 'run-' + randomUUID());
mkdirSync(output, { recursive: true });
const data = join(temp, 'files'),
  repo = join(temp, 'repo'),
  graph = join(temp, 'graph.jsonl'),
  ledger = join(temp, 'ledger.json');
const store = (file, data) =>
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const gitEnv = {
  PATH: process.env.PATH,
  HOME: temp,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (...args) =>
  execFileSync('git', ['-C', repo, ...args], {
    env: gitEnv,
    encoding: 'utf8',
  }).trim();
const target = (command, ...args) => ({ kind: 'stdio', command, args });
function observation(id, tool, args, repeat = false) {
  return {
    id,
    target: 'upstream',
    mode: 'observational',
    tool,
    arguments: args,
    allowSideEffects: true,
    fault: repeat ? { kind: 'duplicate', maxRetries: 1 } : { kind: 'none' },
    expectResponses: repeat ? ['success', 'success'] : ['success'],
    verify: { kind: 'none' },
    invariant: { minEffects: 0, maxEffects: 1 },
    requestTimeoutMs: 8000,
  };
}
async function command(args, cwd) {
  try {
    const { stdout } = await exec(process.execPath, [cli, ...args], {
      cwd,
      timeout: 90000,
    });
    return { code: 0, stdout };
  } catch (e) {
    if (typeof e.code !== 'number') throw e;
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
async function check(
  name,
  upstreamTarget,
  cases,
  expectedStatuses,
  expectedCode,
) {
  const dir = join(output, name),
    config = join(temp, name + '.yaml');
  mkdirSync(dir);
  writeFileSync(
    config,
    stringify({
      version: 1,
      targets: { upstream: upstreamTarget },
      tests: cases,
    }),
  );
  const flags = [
    '-c',
    config,
    '--allow-external',
    ...(upstreamTarget.kind === 'http'
      ? ['--allow-url', upstreamTarget.url]
      : ['--allow-stdio']),
  ];
  const diagnosticArgs = ['doctor', '--json'];
  if (upstreamTarget.kind === 'http')
    diagnosticArgs.push('--url', upstreamTarget.url);
  else {
    const targetFile = join(temp, name + '-target.json');
    store(targetFile, upstreamTarget);
    diagnosticArgs.push('--stdio-config', targetFile, '--allow-stdio');
  }
  const started = performance.now();
  const discovery = await command(diagnosticArgs, temp);
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(discovery.code, 0, discovery.stderr);
  const diagnostic = JSON.parse(discovery.stdout);
  assert.equal(diagnostic.toolCalls, 0);
  assert.equal(diagnostic.safety, 'unassessed');
  store(join(dir, 'doctor.json'), { elapsedMs, diagnostic });
  const list = await command(['list', ...flags], temp);
  writeFileSync(join(dir, 'discovery.txt'), list.stdout + (list.stderr ?? ''));
  assert.equal(list.code, 0, name + ' discovery: ' + list.stderr);
  for (const t of cases)
    assert.ok(
      list.stdout.trim().split('\n').includes(t.tool),
      t.tool + ' missing in ' + name,
    );
  const run = await command(['test', ...flags, '--out', dir], temp);
  console.log(name + '\n' + run.stdout);
  assert.equal(run.code, expectedCode, run.stderr ?? run.stdout);
  const folders = readdirSync(dir).filter((s) => s.startsWith('run-'));
  assert.equal(folders.length, 1);
  const reportPath = join(dir, folders[0], 'report.json');
  const { results, findings } = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.deepEqual(
    results.map((r) => r.status),
    expectedStatuses,
  );
  assert.deepEqual(
    findings.map((f) => f.status),
    expectedStatuses,
  );
  if (name === 'filesystem-append') {
    assert.equal(findings[0].observed.highestObservedEffects, 2);
    assert.equal(findings[0].severity, 'high');
  }
  const expectedReplies = cases.map((t) => t.expectResponses);
  if (name === 'filesystem-negative') expectedReplies[0] = ['tool-error'];
  for (const [i, r] of results.entries()) {
    const observed = r.events
      .filter((e) => e.kind === 'reply')
      .map((e) => e.response);
    assert.deepEqual(observed, expectedReplies[i]);
    assert.equal(r.invocationCount, observed.length);
    assert.equal(
      r.protocolVersion,
      list.stdout.split('\n')[0].slice('Protocol '.length),
    );
  }
  const replay = await command(['report', reportPath], temp);
  assert.equal(replay.code, expectedCode);
  return results;
}
try {
  mkdirSync(data);
  mkdirSync(repo);
  git('init', '--template=', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'Initial fixture state',
  );
  writeFileSync(join(repo, 'sample.txt'), 'sample\n');
  writeFileSync(join(data, 'seed.txt'), 'reference input\n');
  const fsTarget = target(process.execPath, upstream('filesystem'), data);
  const fsCases = [
    observation('read-seed', 'read_text_file', {
      path: join(data, 'seed.txt'),
    }),
    observation(
      'repeat-write',
      'write_file',
      { path: join(data, 'output.txt'), content: '{{operationKey}}' },
      true,
    ),
  ];
  const fsResults = await check(
    'filesystem',
    fsTarget,
    fsCases,
    ['INCONCLUSIVE', 'INCONCLUSIVE'],
    3,
  );
  assert.equal(
    readFileSync(join(data, 'output.txt'), 'utf8'),
    fsResults[1].operationKey,
  );
  store(join(output, 'filesystem', 'backend.json'), {
    fileCount: readdirSync(data).length,
    writtenContentMatchesOperationKey: true,
    settlementSource: null,
  });
  await check(
    'filesystem-negative',
    fsTarget,
    [
      observation('missing-read', 'read_text_file', {
        path: join(data, 'absent.txt'),
      }),
    ],
    ['FAIL'],
    1,
  );
  const appendPath = join(data, 'append-only.txt'),
    appendLedger = join(temp, 'appends.json');
  writeFileSync(appendPath, '');
  const sampleAppends = () => {
    const operations = {};
    for (const key of readFileSync(appendPath, 'utf8').match(
      /op-[0-9a-f]{24}/g,
    ) ?? []) {
      const row = (operations[key] ??= { effects: 0, settledAttempts: 0 });
      row.effects++;
    }
    store(appendLedger + '.next', { version: 1, operations });
    renameSync(appendLedger + '.next', appendLedger);
  };
  sampleAppends();
  const appendTimer = setInterval(sampleAppends, 20);
  try {
    const append = {
      ...observation(
        'repeat-append',
        'append_file',
        { path: appendPath, content: '{{operationKey}}' },
        true,
      ),
      mode: 'verified',
      retryPolicy: 'scheduled',
      verify: { kind: 'file', path: appendLedger },
      invariant: { minEffects: 1, maxEffects: 1 },
      settleTimeoutMs: 400,
    };
    const [r] = await check(
      'filesystem-append',
      fsTarget,
      [append],
      ['FAIL'],
      1,
    );
    assert.equal(r.reason, 'invariant');
    assert.equal(readFileSync(appendPath, 'utf8'), r.operationKey.repeat(2));
    assert.equal(r.events.at(-1).entry.effects, 2);
    store(join(output, 'filesystem-append', 'backend.json'), {
      committedMarkers: 2,
      maximum: 1,
      settlementSource: null,
    });
  } finally {
    clearInterval(appendTimer);
  }
  const http = spawn(
    process.execPath,
    [
      upstream('filesystem'),
      '--transport',
      'streamable-http',
      '--read-only',
      data,
    ],
    {
      cwd: temp,
      env: { PATH: process.env.PATH, HOME: temp, HOST: '127.0.0.1', PORT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const closed = once(http, 'exit');
  try {
    const ready = await new Promise((resolve, reject) => {
      let startup = '';
      const timeout = setTimeout(
        () => reject(new Error('Filesystem HTTP startup timed out.')),
        8000,
      );
      closed.then(() => {
        clearTimeout(timeout);
        reject(new Error('Filesystem HTTP exited during startup.'));
      }, reject);
      http.stderr.on('data', (chunk) => {
        startup = (startup + chunk).slice(-2048);
        const match = startup.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });
    });
    await check(
      'filesystem-http',
      { kind: 'http', url: ready },
      [fsCases[0]],
      ['INCONCLUSIVE'],
      3,
    );
  } finally {
    if (http.exitCode === null && http.signalCode === null) {
      http.kill('SIGTERM');
      const kill = setTimeout(() => http.kill('SIGKILL'), 1500);
      try {
        await closed;
      } finally {
        clearTimeout(kill);
      }
    }
  }
  const memoryCases = [
    observation('read-graph', 'read_graph', {}),
    observation(
      'repeat-entity',
      'create_entities',
      {
        entities: [
          {
            name: '{{operationKey}}',
            entityType: 'fixture',
            observations: ['interop'],
          },
        ],
      },
      true,
    ),
  ];
  const memory = await check(
    'memory',
    target(
      '/usr/bin/env',
      'MEMORY_FILE_PATH=' + graph,
      process.execPath,
      upstream('memory'),
    ),
    memoryCases,
    ['INCONCLUSIVE', 'INCONCLUSIVE'],
    3,
  );
  const entities = readFileSync(graph, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(
    entities.filter((e) => e.name === memory[1].operationKey).length,
    1,
  );
  store(join(output, 'memory', 'backend.json'), {
    matchingEntityRows: 1,
    totalRows: entities.length,
    settlementSource: null,
  });
  // Only append-only commits on main are scheduled in this repository.
  // Moving a branch alone need not create a branch reflog in GitPython.
  let lastHead;
  const refresh = () => {
    const head = readFileSync(join(repo, '.git/refs/heads/main'), 'utf8');
    if (head === lastHead) return;
    const operations = {};
    for (const key of git('log', '--format=%s', 'main')
      .split('\n')
      .filter((s) => /^op-[0-9a-f]{24}$/.test(s))) {
      const row = (operations[key] ??= { effects: 0, settledAttempts: 0 });
      row.effects++;
    }
    lastHead = head;
    store(ledger + '.next', { version: 1, operations });
    renameSync(ledger + '.next', ledger);
  };
  refresh();
  const timer = setInterval(refresh, 15);
  try {
    const commit = {
      ...observation('verify-commit', 'git_commit', {
        repo_path: repo,
        message: '{{operationKey}}',
      }),
      mode: 'verified',
      verify: { kind: 'file', path: ledger },
      invariant: { minEffects: 1, maxEffects: 1 },
      settleTimeoutMs: 800,
    };
    const results = await check(
      'git',
      target(
        '/usr/bin/env',
        'GIT_CONFIG_NOSYSTEM=1',
        'GIT_CONFIG_GLOBAL=/dev/null',
        gitServer,
        '--repository',
        repo,
      ),
      [
        observation('status', 'git_status', { repo_path: repo }),
        observation(
          'repeat-stage',
          'git_add',
          { repo_path: repo, files: ['sample.txt'] },
          true,
        ),
        commit,
      ],
      ['INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE'],
      3,
    );
    assert.equal(
      git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'),
      'sample.txt',
    );
    assert.equal(git('log', '-1', '--format=%s'), results[2].operationKey);
    assert.deepEqual(results[2].events.at(-1).entry, {
      effects: 1,
      settledAttempts: 0,
    });
    store(join(output, 'git', 'backend.json'), {
      committedPaths: ['sample.txt'],
      matchingCommits: 1,
      settlementSource: null,
    });
  } finally {
    clearInterval(timer);
  }
  const py = execFileSync(
    join(deps, '.venv/bin/python'),
    [
      '-c',
      'import sys,importlib.metadata as m; print(sys.version.split()[0],m.version("mcp-server-git"),m.version("mcp"))',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split(' ');
  const version = (name) =>
    JSON.parse(
      readFileSync(
        join(
          deps,
          'node_modules/@modelcontextprotocol/server-' + name,
          'package.json',
        ),
      ),
    ).version;
  store(join(output, 'environment.json'), {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    filesystem: version('filesystem'),
    memory: version('memory'),
    python: py[0],
    gitServer: py[1],
    pythonSdk: py[2],
    git: git('--version'),
  });
  console.log('Reference expectations matched. Evidence: ' + output);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
