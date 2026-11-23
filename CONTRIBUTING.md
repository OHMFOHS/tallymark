# Contributing

Use Node.js 22.12+ and pnpm 9.15.0. Install dependencies with `pnpm install --frozen-lockfile`, then run the checks below.

```sh
pnpm build
pnpm lint
pnpm format:check
pnpm test
```

Integration tests launch the compiled fixture and open ephemeral loopback ports. `pnpm test` builds the current TypeScript before running the suite. Use `pnpm test:package` to verify the exact archive inventory and exercise the packed CLI in a clean offline consumer. Runtime validation and the distributable JSON Schema share a Zod definition. Include the generated schema when it changes.

A scenario contribution should identify the exact fault boundary, retry authorization and conditions that establish settlement. Include positive, violating and inconclusive controls. Keep protocol requirements linked to a dated specification. Use synthetic inputs in issues and report attachments.

## Preparing a release

Update the version in `package.json` and `packages/contracts/version.ts`. Run the checks above and the external harnesses, then run `pnpm test:package --npm`. It installs the tarball in an empty npm consumer with a fresh cache, tests all exit codes, and writes the SHA-256 checksum of the tested bytes beside the archive. The manual beta workflow verifies this checksum before publication. Confirm the canonical repository, registry ownership, trusted publisher and intended tag with the maintainer. [Release checklist](docs/release-checklist.md)
