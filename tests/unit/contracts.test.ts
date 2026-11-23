import { describe, it, expect } from 'vitest';
import { parseSuite, endpoint } from '../../packages/contracts/index.js';
import { requirePermission } from '../../packages/core/connection.js';
import { example, oneCase, options } from '../helpers.js';
describe('contract admission', () => {
  it.each([
    ['duplicate properties', 'version: 1\nversion: 1'],
    ['anchors reused as aliases', 'version: &v 1\nseed: *v'],
    ['oversized configuration', ' '.repeat(65537)],
    ['unknown version', example.replace('version: 1', 'version: 2')],
    ['unknown field', example + '\nextraThing: 1'],
    ['inverted range', example.replace('minEffects: 1', 'minEffects: 2')],
    ['duplicate identifier', example.replace('id: recover', 'id: duplicate')],
    ['unknown target', example.replace('target: ledger', 'target: absent')],
    [
      'unbounded repetition',
      example.replace('maxRetries: 1', 'maxRetries: 900'),
    ],
    ['uncorrelated ledger', example.replace('{{operationKey}}', 'constant')],
    [
      'incomplete response schedule',
      example.replace('[lost, success]', '[success]'),
    ],
  ])('rejects %s', (_name, yaml) => {
    expect(() => parseSuite(yaml)).toThrow();
  });
  it('defaults side effect permission to false', () =>
    expect(
      parseSuite(example.replace('allowSideEffects: true', '')).tests[0]!
        .allowSideEffects,
    ).toBe(false));
  it('reports the field without echoing invalid input', () => {
    const { suite, t } = oneCase();
    Object.assign(t, { requestTimeoutMs: 'secret-password' });
    try {
      parseSuite(JSON.stringify(suite));
      throw new Error('unexpected success');
    } catch (e) {
      expect(String(e)).toContain('tests.0.requestTimeoutMs');
      expect(String(e)).not.toContain('secret-password');
    }
  });
  it.each([
    'file:///tmp/a',
    'http://u:p@localhost/mcp',
    'https://localhost/mcp?token=x',
    'https://localhost/#frag',
  ])('blocks unsafe endpoint %s', (url) =>
    expect(() => endpoint(url)).toThrow(),
  );
  it('checks the exact endpoint before network access', () => {
    const target = { kind: 'http' as const, url: 'http://localhost:8000/mcp' };
    expect(() => requirePermission(target, options)).toThrow();
    expect(() =>
      requirePermission(target, {
        allowExternal: true,
        allowedUrls: ['http://localhost:8000/else'],
      }),
    ).toThrow();
    expect(() =>
      requirePermission(target, {
        allowExternal: true,
        allowedUrls: [target.url],
      }),
    ).not.toThrow();
  });
});
it('requires separate executable permission when only a network endpoint was authorized', () => {
  expect(() =>
    requirePermission(
      { kind: 'stdio', command: 'node', args: [] },
      { allowExternal: true, allowedUrls: ['http://localhost/mcp'] },
    ),
  ).toThrow('--allow-stdio');
});
it.each(['timeout', 'transient'])(
  'rejects a contract that cannot exercise %s',
  (kind) => {
    const { suite, t } = oneCase();
    if (kind === 'timeout') {
      t.fault = { kind: 'timeout', deadlineMs: 200 };
      t.expectResponses = ['success'];
    } else {
      t.fault = { kind: 'transient', failures: 2, maxRetries: 1 };
      t.expectResponses = ['tool-error', 'tool-error'];
    }
    expect(() => parseSuite(JSON.stringify(suite))).toThrow();
  },
);
