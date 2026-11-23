import { z } from 'zod';
import { isAlias, parseDocument, visit } from 'yaml';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const identifier = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/);
const shortText = z.string().min(1).max(2048);
const integer = (min: number, max: number) => z.int().min(min).max(max);
const object = z.strictObject;
export const targetSchema = z.discriminatedUnion('kind', [
  object({ kind: z.literal('fixture'), mode: z.enum(['safe', 'unsafe']) }),
  object({
    kind: z.literal('stdio'),
    command: shortText,
    args: z.array(shortText).max(32).default([]),
  }),
  object({ kind: z.literal('http'), url: z.url().max(2048) }),
]);
const faultSchema = z.discriminatedUnion('kind', [
  object({ kind: z.literal('none') }),
  object({ kind: z.literal('duplicate'), maxRetries: integer(1, 3) }),
  object({ kind: z.literal('lost-response'), maxRetries: z.literal(1) }),
  object({ kind: z.literal('timeout'), deadlineMs: integer(30, 5000) }),
  object({
    kind: z.literal('transient'),
    failures: integer(1, 2),
    maxRetries: integer(1, 3),
  }),
]);
export const responseSchema = z.enum([
  'success',
  'tool-error',
  'lost',
  'timeout',
]);
export const testSchema = object({
  id: identifier,
  target: identifier,
  mode: z.enum(['observational', 'verified']).optional(),
  retryPolicy: z.enum(['after-settlement', 'scheduled']).optional(),
  tool: identifier,
  arguments: z.record(z.string(), z.json()),
  allowSideEffects: z.boolean().default(false),
  fault: faultSchema,
  expectResponses: z.array(responseSchema).min(1).max(4),
  verify: z.discriminatedUnion('kind', [
    object({ kind: z.literal('fixture') }),
    object({ kind: z.literal('none') }),
    object({
      kind: z.literal('file'),
      path: shortText,
      maxAgeMs: integer(1, 86400000).optional(),
    }),
  ]),
  invariant: object({
    minEffects: integer(0, 1000000),
    maxEffects: integer(0, 1000000),
  }),
  requestTimeoutMs: integer(100, 10000).default(3000),
  settleTimeoutMs: integer(50, 5000).default(1000),
});
export const suiteSchema = object({
  version: z.literal(1),
  seed: integer(0, 2147483647).default(1),
  targets: z.record(identifier, targetSchema),
  tests: z.array(testSchema).min(1).max(32),
});
export type Suite = z.infer<typeof suiteSchema>;
export type Case = z.infer<typeof testSchema>;
export type Target = z.infer<typeof targetSchema>;
export type ResponseKind = z.infer<typeof responseSchema>;
export class PublicError extends Error {}

// Refuse special files before reading, and cap growth even after stat().
export async function readBounded(path: string, max: number): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > max)
      throw new PublicError('Expected a regular file within the size limit.');
    const buffer = Buffer.alloc(Math.min(max + 1, stat.size + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await fd.read(
        buffer,
        used,
        buffer.length - used,
        used,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== stat.size) throw new PublicError('File changed during read.');
    return buffer.toString('utf8', 0, used);
  } finally {
    await fd.close();
  }
}

export function endpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicError(
      'Invalid HTTP endpoint. Enter an absolute HTTP(S) URL for the MCP service.',
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new PublicError(
      'Endpoints require an HTTP(S) URL without credentials, query or fragment.',
    );
  return url.href;
}

export function parseSuite(source: string): Suite {
  if (Buffer.byteLength(source) > 65536)
    throw new PublicError('Configuration exceeds 64 KiB.');
  const doc = parseDocument(source, { prettyErrors: false });
  if (doc.errors.length || doc.warnings.length)
    throw new PublicError(
      'Invalid YAML. Check syntax, tags and duplicate keys.',
    );
  visit(doc, (_key, node, path) => {
    if (isAlias(node) || path.length > 24)
      throw new PublicError(
        'YAML aliases and nesting beyond 24 levels are unsupported.',
      );
  });
  const parsed = suiteSchema.safeParse(doc.toJS({ maxAliasCount: 0 }));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const fields = new Set([
      'tests',
      'targets',
      'seed',
      'version',
      ...Object.keys(testSchema.shape),
      'kind',
      'failures',
      'maxRetries',
      'deadlineMs',
      'minEffects',
      'maxEffects',
      'mode',
      'command',
      'args',
      'url',
      'path',
    ]);
    const where = issue.path
      .map((p) =>
        typeof p === 'number' || fields.has(String(p)) ? String(p) : '<field>',
      )
      .join('.');
    throw new PublicError(
      `Invalid configuration at ${where || 'root'} (${issue.code}). See the v1 contract schema.`,
    );
  }
  const suite = parsed.data;
  if (Object.keys(suite.targets).length > 16)
    throw new PublicError('At most 16 targets are supported.');
  for (const target of Object.values(suite.targets))
    if (target.kind === 'http') endpoint(target.url);
  const ids = new Set<string>();
  for (const t of suite.tests) {
    const target =
      Object.hasOwn(suite.targets, t.target) && suite.targets[t.target];
    if (!target) throw new PublicError(`Unknown target for ${t.id}.`);
    if (ids.has(t.id)) throw new PublicError(`Duplicate test id ${t.id}.`);
    ids.add(t.id);
    if (t.invariant.minEffects > t.invariant.maxEffects)
      throw new PublicError(
        `Invalid effect range for ${t.id}. Set minEffects at or below maxEffects.`,
      );
    if (t.retryPolicy === 'after-settlement' && t.verify.kind === 'none')
      throw new PublicError(
        `Retry policy after-settlement requires an observer for ${t.id}.`,
      );
    if (t.mode === 'observational' && t.verify.kind !== 'none')
      throw new PublicError(
        `Observational case ${t.id} requires verify.kind none. Select verified to use an exporter.`,
      );
    if (t.mode === 'verified' && t.verify.kind === 'none')
      throw new PublicError(
        `Verified case ${t.id} requires a fixture or file observer. Select observational to record responses only.`,
      );
    if (t.verify.kind === 'fixture' && target.kind !== 'fixture')
      throw new PublicError('Fixture verification requires a fixture target.');
    if (t.verify.kind !== 'none' && !containsKey(t.arguments))
      throw new PublicError(
        `Use the literal {{operationKey}} in the arguments for ${t.id} to correlate state.`,
      );
    const f = t.fault;
    if (!exercisesFault(t))
      throw new PublicError(
        `Response contract cannot exercise the selected fault for ${t.id}.`,
      );
    const attempts =
      f.kind === 'timeout' || f.kind === 'none'
        ? 1
        : f.kind === 'transient'
          ? Math.min(f.failures, f.maxRetries) + 1
          : f.maxRetries + 1;
    if (t.expectResponses.length !== attempts)
      throw new PublicError(
        `Expected ${attempts} response observations for ${t.id}.`,
      );
  }
  return suite;
}

function containsKey(value: z.core.util.JSONType): boolean {
  if (value && typeof value === 'object')
    return Object.values(value).some(containsKey);
  return value === '{{operationKey}}';
}

export function exercisesFault(
  t: Pick<Case, 'fault' | 'expectResponses'>,
): boolean {
  const f = t.fault;
  if (f.kind === 'none')
    return t.expectResponses.length === 1 && t.expectResponses[0] !== 'lost';
  if (
    f.kind === 'duplicate' &&
    t.expectResponses.slice(0, -1).some((r) => r !== 'success')
  )
    return false;
  if (f.kind === 'timeout')
    return t.expectResponses.length === 1 && t.expectResponses[0] === 'timeout';
  if (f.kind === 'transient')
    return (
      f.maxRetries >= f.failures &&
      t.expectResponses.length === f.failures + 1 &&
      t.expectResponses.slice(0, -1).every((s) => s === 'tool-error') &&
      t.expectResponses.at(-1) === 'success'
    );
  return f.kind !== 'lost-response' || t.expectResponses[0] === 'lost';
}
