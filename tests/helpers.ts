import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSuite } from '../packages/contracts/index.js';
export const directory = fileURLToPath(new URL('../', import.meta.url));
export const example = readFileSync(
  new URL('../examples/reliability.yaml', import.meta.url),
  'utf8',
);
export function oneCase() {
  const suite = parseSuite(example);
  suite.tests = [suite.tests[1]!];
  return { suite, t: suite.tests[0]! };
}
export const options = { directory, allowExternal: false, allowedUrls: [] };
