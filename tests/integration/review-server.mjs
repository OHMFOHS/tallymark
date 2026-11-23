// Independent business fixture for settlement, rejection, cancellation and crash tests.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
} from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
const [path, mode] = process.argv.slice(2);
if (mode === 'startup') appendFileSync(path + '.starts', 'start\n');
function write(
  key,
  effects,
  settledAttempts,
  cancellations,
  settledAttemptIds,
) {
  writeFileSync(
    path + '.new',
    JSON.stringify({
      version: 1,
      ...(mode === 'fresh' ? { publishedAt: new Date().toISOString() } : {}),
      operations: {
        [key]: { effects, settledAttempts, cancellations, settledAttemptIds },
      },
    }),
  );
  renameSync(path + '.new', path);
}
serveStdio(() => {
  const server = new McpServer({ name: 'review-ledger', version: '1' });
  server.registerTool(
    'record_payment',
    { inputSchema: z.object({ operationKey: z.string(), cents: z.number() }) },
    async ({ operationKey: key }, ctx) => {
      const prior = JSON.parse(readFileSync(path, 'utf8')).operations[key];
      const priorIds = prior?.settledAttemptIds ?? [];
      const ids = [
        ...priorIds,
        ctx.mcpReq._meta?.['mcp-reliability-kit/attempt-id'],
      ];
      const attempt = (prior?.settledAttempts ?? 0) + 1;
      if (mode === 'pending-first' || mode === 'late-visibility') {
        const id = ids.at(-1);
        if (id.endsWith('.1')) {
          write(key, 1, 0);
          if (mode === 'late-visibility')
            setTimeout(() => write(key, 1, 1, undefined, [id]), 70);
        } else {
          write(key, 1, 2, undefined, [key + '.1', key + '.2']);
        }
        return { content: [] };
      }
      if (mode === 'hold-second-reply') {
        write(key, attempt, attempt, undefined, ids);
        if (attempt === 2)
          await new Promise((resolve) => setTimeout(resolve, 4000));
        return { content: [] };
      }
      if (mode === 'crash') {
        write(key, 1, 0);
        process.exit(7);
      }
      if (mode === 'ignore-cancel' || mode === 'no-telemetry') {
        write(key, 1, 0);
        await new Promise((resolve) => {
          if (ctx.mcpReq.signal.aborted) resolve();
          else
            ctx.mcpReq.signal.addEventListener('abort', resolve, {
              once: true,
            });
        });
        // The job continues to completion after receiving the signal.
        write(key, 1, 1, mode === 'ignore-cancel' ? 0 : undefined, ids);
      } else if (mode === 'first-rejected' || mode === 'first-empty') {
        write(key, attempt - 1, attempt, undefined, ids);
        if (mode === 'first-rejected' && attempt === 1)
          return {
            isError: true,
            content: [{ type: 'text', text: 'pre-commit rejection' }],
          };
      } else if (mode === 'unsettled-excess') {
        write(key, attempt, 1, undefined, ids.slice(0, 1));
      } else if (mode === 'delayed' && attempt === 2) {
        // A separate test worker releases this durable job after the runner exits.
        writeFileSync(path + '.pending', JSON.stringify({ key, ids }));
      } else if (mode === 'first-excess') {
        write(key, 2, attempt, undefined, ids);
      } else if (mode === 'count-only') {
        write(key, 1, attempt);
      } else if (mode === 'duplicate-ack') {
        write(
          key,
          1,
          attempt,
          undefined,
          ids.map(() => ids[0]),
        );
      } else {
        write(key, 1, attempt, undefined, ids);
      }
      return {
        content: [{ type: 'text', text: 'synthetic-private-response-marker' }],
      };
    },
  );
  return server;
});
