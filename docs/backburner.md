# Backburner: committed receipts from background MCP jobs

Backburner 1.0.0 is an independently published Python MCP service. Its ordinary `start_task` tool starts a background process and returns a job ID. The service stores each job in SQLite and a watcher updates the row after the process exits. This integration runs the PyPI wheel, its registered tool, process launcher and watcher. The kit supplies request correlation, one fixed receipt-writing workload, the two receipt schemas and a separate read-only exporter. [PyPI release](https://pypi.org/project/backburner-mcp/1.0.0/) · [Upstream tool](https://github.com/RohitYajee8076/backburner/blob/42bc06d5c418ce6473ef0a0282994d33798f8a2c/backburner/server.py) · [Job store and watcher](https://github.com/RohitYajee8076/backburner/blob/42bc06d5c418ce6473ef0a0282994d33798f8a2c/backburner/jobs.py)

## Recorded experiment

The three cases use the same business rule: exactly one committed receipt for one operation key. The runner withholds the first decoded reply and may retry once after observing prior settlement. Each case starts with a fresh SQLite database. These results reproduced on macOS arm64 with Node 22.12.0 and 24.22.3. The linked samples use Node 24.22.3, Python 3.13.5, SQLite 3.53.4, Python MCP SDK 2.3.0 and protocol 2026-07-28. [Environment](../integrations/evidence/2026-11-22/backburner/environment.json)

| Case                        | Database evidence at the CLI verdict                                                                                                                                                                                                                                     | Result and replay                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate submission        | Without a unique operation index, jobs `a4cbb956` and `0aae4c6a` each completed. The first attempt committed receipt 1. The second committed receipt 2 for the same key.                                                                                                 | **FAIL**, exit 1. [Report](../integrations/evidence/2026-11-22/backburner/duplicate/report.json) · [Database rows](../integrations/evidence/2026-11-22/backburner/duplicate/database.json)                                                                        |
| Transactional deduplication | The receipt table has a unique index on the operation key. Job `c0a098d1` was terminal with one receipt before retry. Job `2de9c73a` completed and linked to receipt 1. The exporter observed both distinct terminal attempt IDs together with the single receipt.       | **PASS**, exit 0. [Report](../integrations/evidence/2026-11-22/backburner/deduplicated/report.json) · [Database rows](../integrations/evidence/2026-11-22/backburner/deduplicated/database.json)                                                                  |
| Delayed completion          | Job `29cba51a` was working with zero receipts after the 500 ms settlement window. The runner withheld the retry and exited. Only after copying the pending database did the harness release the worker. The same job then committed one receipt and exited successfully. | **INCONCLUSIVE**, exit 3. Offline replay after completion still returned 3. [Original report](../integrations/evidence/2026-11-22/backburner/delayed/report.json) · [Before and after rows](../integrations/evidence/2026-11-22/backburner/delayed/database.json) |

## Evidence boundary

1. The harness mounts the installed Backburner server on a new loopback Streamable HTTP endpoint. SDK middleware restricts calls to the fixed local workload, verifies the operation key against the received attempt metadata, and carries that ID into the private job working directory. Backburner records that directory in its native job row.
2. The worker opens a single `BEGIN IMMEDIATE` transaction in the same database. It inserts or finds the business receipt, then links the actual attempt to that receipt. The deduplicated case enforces uniqueness on the logical key at the write boundary. Both submissions still run as separate native jobs.
3. A separate Python process opens SQLite with `mode=ro`. It counts receipt rows and joins the committed link to the native job in one read transaction. A terminal ID requires a matching receipt, native status `completed`, a finish time and exit code zero. While a job is working, a committed receipt contributes to the count without conferring settlement. Broken links invalidate the export. The exporter timestamps and atomically replaces the v1 ledger. The contract accepts observations at most 1,000 ms old.
4. The harness saves SQLite backups after the CLI returns and after settlement, then reads the three tables directly without calling the exporter. Each case includes its CLI verdict, original event sequence, JUnit, direct database rows, SHA-256 of the two backups, and the offline replay exit. The delayed case holds the worker on a local gate until the first backup is complete. No timing race is needed to obtain the pending snapshot.

The effect under test is a committed receipt in the controlled worker. Backburner schedules both accepted submissions. Deduplication belongs to the worker's SQLite constraint. Likewise, the duplicate is a violation of this particular workload contract. The worker starts no further jobs or external services. Jobs terminally marked failed, cancelled or interrupted cannot earn a positive settlement from this exporter. Other workloads need their own commit and terminal boundaries.

## Reproduce from the checkout

Use a POSIX host, Node 22.12+, pnpm 9.15.0, uv and Python 3.13. The first dependency installation needs registry access. All service data is generated locally. The console prints the exact output directory.

```sh
pnpm install --frozen-lockfile
pnpm build
uv sync --locked --no-install-project --project integrations/backburner
uv run --locked --project integrations/backburner python -m unittest discover -s integrations/backburner -v
pnpm test:backburner
```

The harness exits zero only when all three different CLI exits, native rows, settlement checkpoints and replays match. To inspect an original verdict without running any server:

```sh
pnpm kit report integrations/evidence/2026-11-22/backburner/deduplicated/report.json
pnpm kit report integrations/evidence/2026-11-22/backburner/delayed/report.json
```

To inspect the raw backups from your own run, set `RUN` to the printed directory. The two delayed snapshots refer to the same native job ID.

```sh
sqlite3 -readonly "$RUN/delayed/at-verdict.sqlite" 'SELECT id, status, exit_code FROM jobs; SELECT count(*) FROM receipts;'
sqlite3 -readonly "$RUN/delayed/after-settlement.sqlite" 'SELECT id, status, exit_code FROM jobs; SELECT count(*) FROM receipts;'
sqlite3 -readonly "$RUN/deduplicated/at-verdict.sqlite" 'SELECT attempt_id, receipt_id FROM deliveries ORDER BY attempt_id;'
```

The checkout contains the [runner](../integrations/backburner/validate.py), [correlation middleware](../integrations/backburner/server.py), [business transaction](../integrations/backburner/worker.py), [exporter](../integrations/backburner/exporter.py) and [Python lockfile](../integrations/backburner/uv.lock). The npm archive includes the narrative and recorded JSON/JUnit. The SQLite backups stay in the local run directory.
