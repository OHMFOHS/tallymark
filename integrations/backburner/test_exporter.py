"""Exercise incomplete or contradictory evidence at the SQLite join boundary."""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from exporter import snapshot


class SettlementTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = Path(temp.name).resolve() / "jobs.db"
        self.key = "op-" + "a" * 24
        self.attempt = self.key + ".1"
        self.writer = sqlite3.connect(self.db)
        self.addCleanup(self.writer.close)
        self.writer.executescript("""
            CREATE TABLE jobs(id TEXT, cwd TEXT, status TEXT, finished_at REAL, exit_code INTEGER, created_at REAL);
            CREATE TABLE deliveries(attempt_id TEXT, operation_key TEXT, receipt_id INTEGER);
            CREATE TABLE receipts(id INTEGER, operation_key TEXT);
        """)
        self.writer.execute(
            "INSERT INTO jobs VALUES ('task', ?, 'working', NULL, NULL, 1)",
            (str(self.db.parent / "attempts" / self.attempt),),
        )
        self.writer.commit()

    def entry(self):
        return snapshot(self.db)["operations"][self.key]

    def test_uncommitted_receipt_and_working_job_do_not_settle(self):
        self.writer.execute("INSERT INTO receipts VALUES (1, ?)", (self.key,))
        self.writer.execute(
            "INSERT INTO deliveries VALUES (?, ?, 1)", (self.attempt, self.key)
        )
        self.assertEqual(
            self.entry(), {"effects": 0, "settledAttempts": 0, "settledAttemptIds": []}
        )
        self.writer.commit()
        self.assertEqual(
            self.entry(), {"effects": 1, "settledAttempts": 0, "settledAttemptIds": []}
        )

    def test_native_completion_without_receipt_link_does_not_settle(self):
        self.writer.execute(
            "UPDATE jobs SET status='completed', finished_at=2, exit_code=0"
        )
        self.writer.commit()
        self.assertEqual(self.entry()["settledAttemptIds"], [])

    def test_broken_receipt_link_invalidates_snapshot(self):
        self.writer.execute("INSERT INTO receipts VALUES (1, ?)", ("op-" + "b" * 24,))
        self.writer.execute(
            "INSERT INTO deliveries VALUES (?, ?, 1)", (self.attempt, self.key)
        )
        self.writer.commit()
        with self.assertRaisesRegex(ValueError, "same operation"):
            self.entry()


if __name__ == "__main__":
    unittest.main()
