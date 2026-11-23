import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const { GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_REPOSITORY } = process.env;
if (
  GITHUB_REF_TYPE !== 'tag' ||
  !/^v\d+\.\d+\.\d+-beta\.\d+$/.test(GITHUB_REF_NAME ?? '') ||
  GITHUB_REF_NAME !== 'v' + manifest.version ||
  manifest.name !== 'mcp-reliability-kit' ||
  !GITHUB_REPOSITORY ||
  manifest.repository?.url !==
    'git+https://github.com/' + GITHUB_REPOSITORY + '.git'
) {
  console.error(
    'Release identity mismatch. Select the exact beta version tag and configure the canonical GitHub repository in package.json.',
  );
  process.exitCode = 1;
}
