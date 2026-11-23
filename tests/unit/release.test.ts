import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { directory } from '../helpers.js';

it('requires a matching beta tag, public package identity and canonical source before entering release CI', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrk-tag-'));
  const version = '0.4.0-beta.1',
    tag = 'v' + version;
  const repo = 'test-owner/test-kit',
    url = 'git+https://github.com/' + repo + '.git';
  try {
    for (const [type, ref, source, name, expected] of [
      ['tag', tag, url, 'mcp-reliability-kit', 0],
      ['branch', tag, url, 'mcp-reliability-kit', 1],
      ['tag', 'v0.4.0', url, 'mcp-reliability-kit', 1],
      ['tag', 'v0.4.0-beta.2', url, 'mcp-reliability-kit', 1],
      ['tag', tag, undefined, 'mcp-reliability-kit', 1],
      ['tag', tag, url + '.other', 'mcp-reliability-kit', 1],
      ['tag', tag, url, 'other-package', 1],
    ] as const) {
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({
          version,
          name,
          repository: source ? { url: source } : undefined,
        }),
      );
      const child = spawnSync(
        process.execPath,
        [join(directory, 'scripts/check-release.mjs')],
        {
          cwd,
          env: {
            ...process.env,
            GITHUB_REF_TYPE: type,
            GITHUB_REF_NAME: ref,
            GITHUB_REPOSITORY: repo,
          },
        },
      );
      expect(child.status).toBe(expected);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
