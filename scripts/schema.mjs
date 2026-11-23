import { writeFile, chmod } from 'node:fs/promises';
import { z } from 'zod';
import { suiteSchema } from '../dist/packages/contracts/index.js';
const schema = z.toJSONSchema(suiteSchema, {
  io: 'input',
  reused: 'ref',
  cycles: 'ref',
});
await writeFile(
  new URL('../packages/contracts/schema.json', import.meta.url),
  JSON.stringify(
    { title: 'MCP Reliability Kit contract v1', ...schema },
    null,
    2,
  ) + '\n',
);
await chmod(new URL('../dist/packages/cli/main.js', import.meta.url), 0o755);
