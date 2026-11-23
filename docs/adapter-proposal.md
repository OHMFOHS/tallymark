# Independent state adapter proposal

The Python + SQLite pilot is implemented. A separate read-only process joins committed receipts and native job completion from Backburner 1.0.0. All three intended traces have recorded verdicts and database snapshots. Independent reproduction by another maintainer remains open. [Pilot and reproduction](backburner.md)

Status of the broader interface: design for feedback. The implemented boundary is the v1 atomic JSON file export. No database driver, server plugin, or external certification is required by the CLI.

The proposed first integration called for a small Python exporter for a SQLite-backed work queue. The standard library can read one consistent database transaction containing both the committed effects and terminal jobs. Poll only the synthetic operation keys used in the experiment. A process can publish that snapshot by atomic replacement. The CLI continues to consume local files without loading arbitrary adapter code.

The proposed producer interface takes a logical operation key and returns the committed historical effect count, the distinct attempt IDs proven terminal, optional cancellation observations, completeness and publication time. The producer owns the definition of finality across the transaction and all downstream jobs. A row that merely enqueues work has no terminal ID. A projection lagging the commit log marks its snapshot incomplete. Wall-clock freshness bounds export age; the producer must also bound source lag.

Acceptance requires three traces against one independently maintained service: a witnessed duplicate, a deduplicated operation with complete settlement, and a delayed job that stays unresolved. Publish the synthetic traces and have a second implementer reproduce their verdicts. Consider PostgreSQL after that trial. Evaluate TypeScript and Java producers when maintainers can test their transactional boundaries. The existing Filesystem harness demonstrates a narrow effect counter for an append-only experiment.
