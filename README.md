<p align="center"><img src="docs/assets/tallymark.png" alt="" width="86" height="86"></p>

<h1 align="center">Tallymark</h1>

<p align="center">Execution-safety testing for Model Context Protocol servers</p>

<p align="center"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

**Did a retry commit the same operation twice?** Two successful MCP replies can accompany two committed writes. Tallymark (the MCP Reliability Kit) runs a bounded retry or timeout scenario, compares the replies with independent backend records, and returns a verdict your CI can act on.

[Beta candidate `0.4.0-beta.2`](docs/beta-validation.md) · Node.js 22.12+ · [MIT license](LICENSE)

## What a verdict looks like

One operation should create exactly one receipt. In this experiment, the Backburner Python MCP server ran a receipt-writing job against SQLite. The test withheld the first reply. The three runs used the same business rule.

| Scenario                                                          | Tool calls | Receipts at verdict → after settlement | Verdict                                                                               |
| ----------------------------------------------------------------- | ---------: | -------------------------------------- | ------------------------------------------------------------------------------------- |
| Each submission inserted a receipt                                |          2 | 2 → 2                                  | [**FAIL**](integrations/evidence/2026-11-22/backburner/duplicate/database.json)       |
| A unique operation key deduplicated both jobs                     |          2 | 1 → 1                                  | [**PASS**](integrations/evidence/2026-11-22/backburner/deduplicated/database.json)    |
| The first job was still running, so the runner withheld the retry |          1 | 0 → 1                                  | [**INCONCLUSIVE**](integrations/evidence/2026-11-22/backburner/delayed/database.json) |

Each verdict links to the database evidence. The delayed job committed after the CLI returned. In a separate HTTP experiment, a Python handler received cancellation and an already admitted job still committed after the client exited. [Backburner experiment](docs/backburner.md) · [Client, server and SQLite cancellation traces](docs/http-cancellation.md)

## Quick start

From the source checkout, use Node.js 22.12+ and pnpm 9.15.0. The bundled fixture has its own temporary ledger.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm kit doctor
mkdir -p artifacts/demo
pnpm kit init -c artifacts/demo/safe.yaml
pnpm kit test -c artifacts/demo/safe.yaml --out artifacts/demo/reports
```

`doctor` discovers the fixture with zero tool calls. The test command exercises four verified cases, exits 0 and prints the JSON and JUnit paths. To try a negative control, initialize another file with `--fixture unsafe`.

You can also inspect a real failure offline. This command exits 1. Both appends succeeded, and an independent reader counted two markers where the contract allowed one. [Raw report](integrations/evidence/2026-11-22/filesystem-append/report.json)

```sh
pnpm kit report integrations/evidence/2026-11-22/filesystem-append/report.json
```

```text
FAIL         repeat-append  calls=2 effects=2
  append_file · duplicate · verified · severity high
  2 committed effects observed for one logical operation. The declared maximum is 1.
```

<details>
<summary>Install the beta candidate in another project</summary>

From the checkout, run `pnpm test:package --npm` to build and exercise the archive in a fresh npm consumer. The tarball and its SHA-256 file are written to `artifacts/pack`. From the consumer project, use the path to your local archive.

```sh
npm install --save-dev /path/to/mcp-reliability-kit-0.4.0-beta.2.tgz
npx --no-install mcp-reliability-kit doctor
```

The package and CLI use the name `mcp-reliability-kit`. The candidate is distributed locally pending public release. [Release checklist](docs/release-checklist.md)

</details>

## Connect your server

Discover the tools on a running Streamable HTTP server. Use a tool name from discovery when initializing the observation. The example uses `read_counter`.

```sh
pnpm kit doctor --url http://localhost:3000/mcp
pnpm kit init --url http://localhost:3000/mcp --tool read_counter -c observe.yaml
pnpm kit test -c observe.yaml
```

The generated case starts disabled. The first test exits 3 with `SKIPPED` and zero calls. Review the arguments and set `allowSideEffects: true` when ready. The following command authorizes one call to that endpoint.

```sh
pnpm kit test -c observe.yaml --allow-external --allow-url http://localhost:3000/mcp
```

Doctor lists the negotiated protocol, tool names, advertised read-only hints and task requirements. Use `--json` for machine-readable output. Remote HTTPS discovery also requires `--allow-url` with the same URL. A matched response in an observational run leaves execution safety `INCONCLUSIVE`.

<details>
<summary>Connect a local stdio server</summary>

Review the executable and argument array before passing `--allow-stdio`. SDK negotiation can start the process twice. For the locked Filesystem reference example, run from the checkout with Node.js 24+.

```sh
npm ci --prefix integrations/reference --ignore-scripts --no-audit --no-fund
export PATH="$PWD/integrations/reference/node_modules/.bin:$PATH"
pnpm kit doctor --stdio-config examples/stdio-target.json --allow-stdio
pnpm kit init --example filesystem -c filesystem.yaml
```

</details>

## Write a verified contract

An observational suite records responses and timeouts. A response mismatch can fail its contract. To verify a business effect, supply an independent count of committed effects and the IDs of attempts that have reached their terminal state. An observed excess can establish `FAIL` immediately. A `PASS` also requires the expected replies, the required checks before each retry and complete final settlement.

```yaml
version: 1
targets:
  ledger: { kind: fixture, mode: safe }
tests:
  - id: lost-reply
    target: ledger
    mode: verified
    tool: record_payment
    arguments: { operationKey: '{{operationKey}}', cents: 1250 }
    allowSideEffects: true
    fault: { kind: lost-response, maxRetries: 1 }
    expectResponses: [lost, success]
    verify: { kind: fixture }
    invariant: { minEffects: 1, maxEffects: 1 }
```

For your own service, propagate the logical operation key and distinct attempt IDs to the transaction or job that commits the effect. Configure `verify: {kind: file, path: ledger.json}` and publish complete, atomic snapshots. Add `maxAgeMs` to bound snapshot age. For response-only observations use `mode: observational` and `verify: {kind: none}`. [Contract and exporter format](docs/contract-spec.md) · [Troubleshooting](docs/troubleshooting.md)

## CI and recovery

The consumer workflow preserves the exit code, writes a job summary and uploads JSON and JUnit. It starts with the bundled fixture. Use a reviewed suite and disposable service when applying it to your application. [GitHub Actions template](examples/ci/verified.yml) · [Setup guide](docs/ci.md)

| Exit | Meaning for a test suite                                                                         |
| ---: | ------------------------------------------------------------------------------------------------ |
|    0 | Every case passed its verified contract.                                                         |
|    1 | At least one case demonstrated a violation.                                                      |
|    2 | Configuration, infrastructure, cleanup or report error. Takes precedence over 1.                 |
|    3 | At least one `INCONCLUSIVE` or `SKIPPED` case, with no `FAIL` or `ERROR`. The gate stays closed. |

Use `report "$REPORT_JSON"` for offline inspection. Each finding includes a command for reproducing its case. If the runner exits early, use `mcp-reliability-kit journal "$PROGRESS_JSON"` with the path printed on stderr at startup. A valid incomplete journal exits 3. Reconcile the possible attempt IDs with the authoritative backend before a live rerun. [Architecture](docs/architecture.md) · [Limits of the evidence](docs/limitations.md)

## Project status

The local beta rehearsal covered macOS and Debian arm64, including Filesystem, Memory, Git and Backburner. Hosted CI and public npm publication are pending. [Validation results and timings](docs/beta-validation.md) · [Compatibility](docs/compatibility.md)

MCP Rig supports wire-level reply drops, retries and verification tools. Tallymark's lost-response scenario withholds a decoded SDK reply at the application boundary. Its built-in workflow reconciles retries with an independent business ledger and carries unresolved outcomes through to CI. [Comparison with MCP Rig, Inspector and other tools](docs/competitive-analysis.md)

[Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)
