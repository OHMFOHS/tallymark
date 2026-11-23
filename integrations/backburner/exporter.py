"""Read a Backburner SQLite snapshot without write access. Publish the v1 ledger."""

import json
import re
import sqlite3
import sys
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


def snapshot(database):
    published = (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    operations = {}

    def entry(key):
        return operations.setdefault(
            key, {"effects": 0, "settledAttempts": 0, "settledAttemptIds": []}
        )

    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        for key, count in db.execute(
            "SELECT operation_key, COUNT(*) FROM receipts GROUP BY operation_key"
        ):
            entry(key)["effects"] = count
        # A successful process exit plus its committed receipt association is
        # the terminal boundary for this fixed, single-process workload.
        jobs = db.execute(
            """
            SELECT j.cwd, j.status, j.finished_at, j.exit_code, d.operation_key, r.operation_key
              FROM jobs AS j
              LEFT JOIN deliveries AS d ON j.cwd = ? || d.attempt_id
              LEFT JOIN receipts AS r ON r.id = d.receipt_id AND r.operation_key = d.operation_key
             ORDER BY j.created_at, j.id
        """,
            (str(database.parent / "attempts") + "/",),
        )
        seen = set()
        for cwd, status, finished, code, delivered_key, receipt_key in jobs:
            path = Path(cwd)
            attempt = path.name
            if (
                path.parent != database.parent / "attempts"
                or not re.fullmatch(r"op-[0-9a-f]{24}\.[1-4]", attempt)
                or attempt in seen
            ):
                raise ValueError("Uncorrelated job in the private experiment database")
            seen.add(attempt)
            key = attempt.rsplit(".", 1)[0]
            if delivered_key is not None and (
                delivered_key != key or receipt_key != key
            ):
                raise ValueError(
                    "Delivery does not reference a receipt for the same operation"
                )
            row = entry(key)
            if (
                status == "completed"
                and finished is not None
                and code == 0
                and delivered_key == key
            ):
                row["settledAttemptIds"].append(attempt)
                row["settledAttempts"] += 1
    return {
        "version": 1,
        "complete": True,
        "publishedAt": published,
        "operations": operations,
    }


def publish(path, data):
    staging = path.with_suffix(".next")
    staging.write_text(json.dumps(data) + "\n")
    staging.replace(path)


if __name__ == "__main__":
    database, ledger = map(lambda arg: Path(arg).resolve(), sys.argv[1:])
    try:
        while True:
            publish(ledger, snapshot(database))
            time.sleep(0.025)
    except Exception:
        publish(ledger, {"version": 1, "complete": False, "operations": {}})
        raise
