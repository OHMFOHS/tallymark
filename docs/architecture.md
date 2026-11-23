# Architecture

A single npm distribution keeps the CLI, fixture executable and contract schema at the same version. Source modules under `packages/` have separate responsibilities. The CLI owns configuration files, explicit permissions and report output. Contracts validate data before the runner can launch a process. Core owns one SDK connection per case, schedules bounded attempts and observes a keyed state ledger. Reporters consume evidence without access to the MCP connection.

The application boundary suppresses a completed SDK reply for the lost-response scenario. Each authorized retry issues a fresh SDK call with identical application arguments. An observer outside the MCP transport reads the ledger before execution, before every scheduled retry, and after the scheduled attempts. Each SDK call carries a distinct metadata ID. The observer requires the full set of matching terminal IDs and a committed effect count. The producer owns the guarantee that each recorded invocation has finished all its downstream work. A successful response alone cannot establish the invariant.

A bundled fixture owns its isolated directory for one case. Its single writer commits a complete state snapshot using an atomic replacement. The safe writer deduplicates by application key at the effect boundary. Scenarios run sequentially. External processes and their ledger producers belong to the developer and require an explicit trust decision.

## From observation to verdict

The ordered event list contains client dispatch and reply observations, plus readings from the independent observer. Assertions are computed from those facts. A known excess of committed effects disproves a bound immediately. A PASS additionally requires a clean baseline, the expected responses, consistent cumulative snapshots, all required pre-retry checkpoints and the exact final terminal set. Correlation uses the run-specific operation key and request metadata. Protocol discovery passes the admitted tool definition into the SDK call so a header mismatch cannot silently schedule another tool invocation.

Before starting any server the CLI writes a private `pending-*/progress.json` with the planned case IDs. Before each attempted dispatch, including retries, it flushes and atomically replaces the journal with the case, tool, operation key and next ordinal. If this write fails the suite stops before issuing that call. After a case completes, the CLI saves its evidence and clears the active case in one replacement. On normal completion it writes and flushes the JSON/JUnit pair and renames their directory to `run-*`. Consumers must enumerate published `run-*` directories. An interrupted CLI can leave a journal or staging files under `pending-*`. They are diagnostic artifacts. The CLI does not automatically replay side effects from an interrupted run.

## Discovery and findings

Doctor uses the same bounded MCP connection and cleanup path as list. Its diagnostic reads negotiated protocol and discovery metadata. The command never dispatches a tool. It displays sanitized names and allowlisted hint fields. Loopback URLs authorize their exact endpoint; remote discovery additionally requires HTTPS and an exact allowlist entry. A local stdio target file requires explicit launch permission. The default fixture has private temporary state.

The reporter computes each finding from the public contract projection, ordered events, reason and verdict. Terminal and JSON output use the same derivation. Saved prose has no authority during replay. An optional maximum export age adds a timestamp check at the same checkpoints that establish causal settlement.
