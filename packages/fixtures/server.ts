import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  fstatSync,
  readSync,
  constants,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { attemptMetaKey } from '../contracts/attempt.js';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';

const stateSchema = z.object({
  version: z.literal(1),
  operations: z.record(
    z.string(),
    z.object({
      receipts: z.array(z.int().positive()),
      effects: z.int().nonnegative(),
      settledAttempts: z.int().nonnegative(),
      settledAttemptIds: z.array(z.string()).optional(),
      cancellations: z.int().nonnegative(),
    }),
  ),
});
type State = z.infer<typeof stateSchema>;

function readState(path: string): State {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024)
      throw new Error('Invalid fixture ledger.');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const n = readSync(fd, data, offset, data.length - offset, offset);
      if (!n) throw new Error('Truncated fixture ledger.');
      offset += n;
    }
    return stateSchema.parse(JSON.parse(data.toString('utf8')));
  } finally {
    closeSync(fd);
  }
}

// One fixture process owns this directory. Check, effect and settlement are
// synchronous so concurrent requests in that process cannot interleave here.
class PaymentBook {
  constructor(private readonly path: string) {
    if (!existsSync(path)) this.transaction(() => undefined);
  }
  transaction<T>(change: (data: State) => T): T {
    // Fail closed on overlapping writers. Read under the lock so a second
    // fixture process cannot overwrite an already committed receipt.
    const lock = this.path + '.lock';
    const fd = openSync(lock, 'wx', 0o600);
    try {
      const state: State = existsSync(this.path)
        ? readState(this.path)
        : { version: 1, operations: {} };
      const result = change(state);
      this.persist(state);
      return result;
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  private persist(state: State) {
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > 256 * 1024)
      throw new Error('Fixture ledger is full.');
    const next = this.path + '.' + randomUUID() + '.next';
    const fd = openSync(next, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(next, this.path);
    } finally {
      if (existsSync(next)) unlinkSync(next);
    }
    const dir = openSync(dirname(this.path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}

export function paymentServer(
  mode: 'safe' | 'unsafe',
  path: string,
  failures = 0,
  hold = false,
) {
  const book = new PaymentBook(path);
  const server = new McpServer(
    { name: mode + '-payment-book', version: '1.0.0' },
    { maxToolInputElements: 16 },
  );
  server.registerTool(
    'record_payment',
    {
      description: 'Record a synthetic payment in the local test ledger.',
      inputSchema: z.object({
        operationKey: z.string().regex(/^op-[a-f0-9]{24}$/),
        cents: z.int().min(1).max(1000000),
      }),
    },
    async ({ operationKey, cents }, ctx) => {
      const id = ctx.mcpReq._meta?.[attemptMetaKey];
      const settle = (row: State['operations'][string]) => {
        row.settledAttempts++;
        if (typeof id === 'string' && /^op-[a-f0-9]{24}\.[1-4]$/.test(id))
          (row.settledAttemptIds ??= []).push(id);
      };
      const accepted = book.transaction((state) => {
        const row = (state.operations[operationKey] ??= {
          receipts: [],
          effects: 0,
          settledAttempts: 0,
          cancellations: 0,
        });
        if (
          row.settledAttempts < failures ||
          (mode === 'safe' &&
            row.receipts.length > 0 &&
            row.receipts[0] !== cents)
        ) {
          settle(row);
          return false;
        }
        if (mode === 'unsafe' || row.receipts.length === 0)
          row.receipts.push(cents);
        row.effects = row.receipts.length;
        if (!hold) settle(row);
        return true;
      });
      if (!accepted)
        return {
          isError: true,
          content: [{ type: 'text', text: 'Payment rejected.' }],
        };
      if (hold) {
        const signal = ctx.mcpReq.signal;
        // The reply stays pending until the SDK delivers cancellation. The
        // watchdog also releases a handler whose client disappeared.
        const stop = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
        if (!stop.aborted)
          await new Promise<void>((resolve) =>
            stop.addEventListener('abort', () => resolve(), { once: true }),
          );
        book.transaction((state) => {
          const row = state.operations[operationKey]!;
          if (signal.aborted) row.cancellations++;
          settle(row);
        });
      }
      return { content: [{ type: 'text', text: 'Payment recorded.' }] };
    },
  );
  return server;
}

export async function serve(
  mode: string | undefined,
  path: string | undefined,
  failures = '0',
  hold = 'no',
) {
  if (
    (mode !== 'safe' && mode !== 'unsafe') ||
    !path ||
    !['0', '1', '2'].includes(failures) ||
    !['yes', 'no'].includes(hold)
  )
    throw new Error('Invalid fixture settings.');
  serveStdio(() => paymentServer(mode, path, Number(failures), hold === 'yes'));
}
