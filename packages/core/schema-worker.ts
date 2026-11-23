import { readFileSync } from 'node:fs';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';
import type { JsonSchemaType } from '@modelcontextprotocol/client';
try {
  const { schema, input } = JSON.parse(readFileSync(0, 'utf8')) as {
    schema: JsonSchemaType;
    input: unknown;
  };
  process.exitCode = new CfWorkerJsonSchemaValidator().getValidator(schema)(
    input,
  ).valid
    ? 0
    : 1;
} catch {
  process.exitCode = 2;
}
