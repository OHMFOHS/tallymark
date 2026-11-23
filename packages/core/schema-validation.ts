import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { JsonSchemaType } from '@modelcontextprotocol/client';

// The SDK validator interface is synchronous. Keep remote schema evaluation
// out of the runner process so its own event-loop timer is not the watchdog.
export class BoundedSchemaValidator {
  constructor(private readonly timeoutMs = 1500) {}
  getValidator<T>(schema: JsonSchemaType) {
    return (input: unknown) => {
      const payload = JSON.stringify({ schema, input });
      const failure = {
        valid: false as const,
        data: undefined,
        errorMessage: 'Schema validation failed or exceeded its budget.',
      };
      if (Buffer.byteLength(payload) > 3 * 1024 * 1024) return failure;
      const worker = spawnSync(
        process.execPath,
        [
          '--max-old-space-size=96',
          fileURLToPath(new URL('./schema-worker.js', import.meta.url)),
        ],
        {
          input: payload,
          timeout: this.timeoutMs,
          killSignal: 'SIGKILL',
          env: {},
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
      return worker.status === 0 && !worker.error
        ? { valid: true as const, data: input as T, errorMessage: undefined }
        : failure;
    };
  }
}
