# Developer beta validation · 2026-11-22

## Current candidate · 0.4.0-beta.2

The release rehearsal on 2026-11-22 used macOS arm64 with Node 22.12.0, 24.22.3 and 26.13.1, and a fresh Debian Bookworm arm64 container with Node 24.22.3. All four runs passed 91 tests. The Debian checkout snapshot started without dependencies or build output. The frozen install, schema comparison, build, lint and format checks passed.

- The process-kill regression observed two committed writes before the second reply. Offline inspection recovered the two attempt IDs. Failing a pre-dispatch journal write at attempt one or two left zero or one committed writes, respectively.
- On both operating systems the fresh-cache npm consumer checked the exact tar inventory, safe HTTP initialization, journal inspection, JSON replay, JUnit, and all five verdicts through the consumer CI script. The smoke test records a SHA-256 checksum of the archive it installed. Use the checksum accompanying the selected tarball. Technical references to source, tests and harnesses in the review documents use paths in the matching source checkout.
- Both platforms independently reproduced all six reference harness groups, three SQLite exporter unit tests, the three Backburner verdicts and nine cancellation scenarios. For Backburner, duplicate submission produced two receipts, deduplication produced one for two jobs, and delayed execution produced zero at verdict time and one after release. For the older HTTP client, the admitted timeout produced one call, one cancellation notification received and one eventual commit.
- The full pnpm audit and the npm audits of both JavaScript interoperability projects reported zero known advisories on the rehearsal date. The protected GitHub Actions matrix, npm publisher identity and registry publication require the maintainer's repository and authorization. [Release gates](release-checklist.md)

## Previous candidate · 0.4.0-beta.1

Candidate `0.4.0-beta.1` was exercised locally on macOS arm64. The unchanged 0.3.0 baseline built and passed all 80 tests before the adoption changes. The unscoped npm name returned HTTP 404 on the review date. The instructions below use the local tarball. [Release gates](release-checklist.md)

## Time to first useful result

Each row is one measured run. The clock started with a prepared source checkout or tarball, an installed runtime and package manager, and access to the npm registry. The HTTP server was already running with its own disposable data directory. These times exclude provisioning, downloading Node and reading or authoring a business contract.

| Starting point                                              | Work included                                                                                                      | Measured time | Result                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Source, Node 22.12.0 and pnpm 9.15.0, empty store           | Frozen install 2,318 ms, build 1,567 ms, fixture doctor 440 ms                                                     | 4,326 ms      | Fixture discovered. [Timing](../integrations/evidence/2026-11-22/source-timing.json)                                               |
| Consumer, Node 24.22.3 and npm 11.8.0, empty registry cache | Install tarball 1,434 ms, run installed fixture doctor 557 ms                                                      | 1,992 ms      | Diagnostic returned unassessed. [Timing](../integrations/evidence/2026-11-22/consumer-timing.json)                                 |
| Consumer, Node 24.22.3 and npm 11.8.0, another empty cache  | Install tarball 1,180 ms, run local `npx --no-install` doctor against Filesystem 2.4.0 over Streamable HTTP 485 ms | 1,665 ms      | Ten advertised tools, zero tool calls, safety unassessed. [Timing](../integrations/evidence/2026-11-22/installed-http-timing.json) |

To repeat the last path, start read-only Filesystem over loopback with the locked reference dependencies, install the candidate in a fresh consumer and run the following against its printed URL. Supply a new empty directory to `--cache` to repeat the cold registry installation. [Reference setup](compatibility.md) · [Quickstart](../README.md)

```sh
npm install --save-dev --ignore-scripts --cache "$EMPTY_CACHE" "$LOCAL_TARBALL"
npx --no-install mcp-reliability-kit doctor --url "$MCP_URL" --json
```

## Verification record

| Check                     | Local result                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full regression suite     | 87 tests in 11 files passed on each of Node 22.12.0, 24.22.3 and 26.13.1. Controls include HTTP method capture during diagnosis, explicit stdio permission, freshness-aware run and replay, and seven release identity combinations.                                                                                                                                                                                |
| Independent servers       | Filesystem 2.4.0, Memory 2.2.1 and Python Git 2026.11.18. On Node 24 and 26 each harness ran six suites, ten cases and 14 tool calls. A double append breached an explicitly declared limit. A missing-file read failed its expected response. The other eight cases remained INCONCLUSIVE. Offline replay preserved the exits. [Compatibility](compatibility.md) · [Evidence](../integrations/evidence/2026-11-22) |
| Artifact consistency      | Independently parsed the JUnit XML and checked each case ID, verdict, call count and ordered events against the JSON on Node 24 and Node 26 runs. Appended markers were counted separately from MCP replies.                                                                                                                                                                                                        |
| Package and consumer gate | Checked the explicit archive inventory, installed in an isolated consumer and exercised all five CLI commands. Executed the same shell step shipped in the downstream workflow against five different verdicts. PASS returned 0, FAIL 1, ERROR 2, and INCONCLUSIVE and SKIPPED each returned 3 with an Actions summary.                                                                                             |
| Build and dependencies    | Frozen root install, TypeScript build, generated-schema stability, ESLint, strict type checks and Prettier checked locally. Root runtime/full and isolated reference npm audits returned zero known advisories on this date. These checks cover the npm graphs.                                                                                                                                                     |
| Workflow definitions      | actionlint 1.7.9 checked all three workflows. Release preflight rejected a branch with the same name as the version tag, a wrong version or package, and a missing or mismatched canonical repository. A matching synthetic tag passed locally.                                                                                                                                                                     |
| Remaining release work    | Hosted Actions matrix, protected environment, real publisher identity, private security contact and npm first-publication procedure require the maintainer. The original reference runs produced no external positive control. The subsequent [Backburner pilot](backburner.md) obtained a verified PASS for a controlled SQLite workload. [Checklist](release-checklist.md)                                        |

Two local workflow checks affected the delivered implementation. The consumer shell now constructs its argument list with positional parameters so an empty permission list works with Bash 3 and nounset. The release preflight checks tag type and package identity explicitly in Node. During validation a compound Bash guard continued after the branch-type predicate failed on macOS Bash 3.

## Commands used from the checkout

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm format:check
pnpm test
npm ci --prefix integrations/reference --ignore-scripts --no-audit --no-fund
uv sync --locked --no-install-project --project integrations/reference
pnpm test:reference
pnpm test:package
pnpm test:package --npm
pnpm audit --prod
pnpm audit
npm audit --prefix integrations/reference
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.9 .github/workflows/ci.yml .github/workflows/release-beta.yml examples/ci/verified.yml
```

Run `pnpm test` with each Node version above, and use Node 24 or 26 for the external implementations. Use `pnpm test:package --npm` with registry access for a new npm cache. The offline pnpm smoke test needs a populated pnpm store. Timing JSON records individual experiments and does not predict the effort of connecting an authoritative exporter.
