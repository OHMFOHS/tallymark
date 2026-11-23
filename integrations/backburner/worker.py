"""The entire downstream job: commit one receipt or link to the existing receipt."""

import sqlite3
import time
from pathlib import Path

directory = Path.cwd()
attempt = directory.name
key = attempt.rsplit(".", 1)[0]
root = directory.parents[1]

# The cancellation experiment can request a fixed-duration workload. It runs
# to completion on its own clock, even after the client process has exited.
if (root / "two-second-workload").is_file():
    time.sleep(2)

# Only the gated experiment creates this gate. The harness exclusively opens
# it after the real CLI has exited and the pending database has been copied.
deadline = time.monotonic() + 15
while (root / "hold").exists():
    if time.monotonic() >= deadline:
        raise TimeoutError("Experiment did not release the job")
    time.sleep(0.025)

with sqlite3.connect(root / "jobs.db") as db:
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("BEGIN IMMEDIATE")
    created = db.execute(
        "INSERT INTO receipts(operation_key, created_by) VALUES (?, ?) "
        "ON CONFLICT DO NOTHING RETURNING id",
        (key, attempt),
    ).fetchone()
    receipt_id = (
        created[0]
        if created
        else db.execute(
            "SELECT id FROM receipts WHERE operation_key=?", (key,)
        ).fetchone()[0]
    )
    db.execute("INSERT INTO deliveries VALUES (?, ?, ?)", (attempt, key, receipt_id))
