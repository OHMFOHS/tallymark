"""Run the public CLI against the installed Backburner and an independent exporter."""

import hashlib
import json
import os
import platform
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from contextlib import ExitStack, closing, contextmanager
from importlib.metadata import version
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CLI = ROOT / "dist/packages/cli/main.js"


def write(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n")


@contextmanager
def child(args, env, log, **options):
    with log.open("w") as output:
        proc = subprocess.Popen(args, stdout=output, stderr=output, env=env, **options)
        try:
            yield proc
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)


def wait_for(check, processes, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(proc.poll() is not None for proc in processes):
            raise RuntimeError("A service exited. Inspect the per-case logs.")
        if check():
            return
        time.sleep(0.025)
    raise TimeoutError("The expected database or exporter state did not arrive.")


def run_cli(args, expected):
    result = subprocess.run(
        ["node", CLI, *args], capture_output=True, text=True, timeout=35
    )
    if result.returncode != expected:
        raise RuntimeError(
            f"CLI returned {result.returncode}, expected {expected}\n{result.stdout}\n{result.stderr}"
        )
    return result.stdout


def checkpoint(db_path, dest):
    # Take a SQLite backup, then audit it directly, independently of exporter.py.
    with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as src:
        with closing(sqlite3.connect(dest)) as db:
            src.backup(db)
            db.row_factory = sqlite3.Row

            def rows(sql):
                return [dict(r) for r in db.execute(sql)]

            jobs = rows(
                "SELECT id, cwd, status, exit_code, created_at, finished_at FROM jobs ORDER BY created_at, id"
            )
            for job in jobs:
                job["attempt_id"] = Path(job.pop("cwd")).name
            return {
                "backupSha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
                "uniqueOperationIndex": "one_receipt_per_operation"
                in {r["name"] for r in db.execute("PRAGMA index_list(receipts)")},
                "jobs": jobs,
                "receipts": rows("SELECT * FROM receipts ORDER BY id"),
                "deliveries": rows("SELECT * FROM deliveries ORDER BY attempt_id"),
            }


def prepare_store(home, deduplicate):
    env = {
        "HOME": str(home),
        "BACKBURNER_HOME": str(home),
        "PATH": str(Path(sys.executable).parent) + os.pathsep + os.defpath,
        "BACKBURNER_ALLOW": r"\Apython3 -I worker\.py\Z",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    database = home / "jobs.db"
    with closing(sqlite3.connect(database)) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE receipts(id INTEGER PRIMARY KEY, operation_key TEXT NOT NULL, created_by TEXT NOT NULL);
            CREATE TABLE deliveries(attempt_id TEXT PRIMARY KEY, operation_key TEXT NOT NULL,
                                    receipt_id INTEGER NOT NULL REFERENCES receipts(id));
        """)
        if deduplicate:
            db.execute(
                "CREATE UNIQUE INDEX one_receipt_per_operation ON receipts(operation_key)"
            )
    return env, database


def run_case(name, expected_status, expected_exit, run):
    delayed = name == "delayed"
    deduplicate = name != "duplicate"
    out = run / name
    out.mkdir()
    with tempfile.TemporaryDirectory(prefix="mrk-job-") as temp, ExitStack() as stack:
        home = Path(temp).resolve()
        (home / "attempts").mkdir()
        gate = home / "hold"
        if delayed:
            gate.touch()
        env, database = prepare_store(home, deduplicate)
        # One loopback endpoint with an unguessable path for this experiment.
        route = "/" + uuid.uuid4().hex + "/mcp"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            url = f"http://127.0.0.1:{sock.getsockname()[1]}{route}"
            server = stack.enter_context(
                child(
                    [sys.executable, HERE / "server.py", str(sock.fileno()), route],
                    env,
                    out / "server.log",
                    cwd=home,
                    pass_fds=(sock.fileno(),),
                )
            )
        doctor = json.loads(run_cli(["doctor", "--url", url, "--json"], 0))
        assert "start_task" in [tool["name"] for tool in doctor["tools"]]
        assert doctor["toolCalls"] == 0 and doctor["safety"] == "unassessed"
        ledger = home / "ledger.json"
        exporter = stack.enter_context(
            child(
                [sys.executable, HERE / "exporter.py", database, ledger],
                env,
                out / "exporter.log",
                cwd=home,
            )
        )
        wait_for(ledger.exists, [server, exporter])
        config = {
            "version": 1,
            "targets": {"backburner": {"kind": "http", "url": url}},
            "tests": [
                {
                    "id": name,
                    "target": "backburner",
                    "mode": "verified",
                    "tool": "start_task",
                    "arguments": {
                        "command": "python3 -I worker.py",
                        "cwd": "{{operationKey}}",
                        "timeout_seconds": 20,
                    },
                    "allowSideEffects": True,
                    "fault": {"kind": "lost-response", "maxRetries": 1},
                    "retryPolicy": "after-settlement",
                    "expectResponses": ["lost", "success"],
                    "invariant": {"minEffects": 1, "maxEffects": 1},
                    "verify": {"kind": "file", "path": str(ledger), "maxAgeMs": 1000},
                    "settleTimeoutMs": 500 if delayed else 4500,
                }
            ],
        }
        suite = home / "suite.json"
        write(suite, config)
        try:
            run_cli(
                [
                    "test",
                    "-c",
                    suite,
                    "--allow-external",
                    "--allow-url",
                    url,
                    "--out",
                    out,
                ],
                expected_exit,
            )
            cli_returned = time.time()
            [report_file] = out.glob("run-*/report.json")
            shutil.copyfile(report_file, out / "report.json")
            shutil.copyfile(report_file.with_name("junit.xml"), out / "junit.xml")
            report = json.loads(report_file.read_text())
            [row] = report["results"]
            key = row["operationKey"]
            assert report["reportVersion"] == 4 and row["status"] == expected_status
            assert (
                row["reason"]
                == {
                    "duplicate": "invariant",
                    "deduplicated": "verified",
                    "delayed": "retryBlocked",
                }[name]
            )
            calls = 1 if delayed else 2
            ids = [f"{key}.{i}" for i in range(1, calls + 1)]
            assert (
                row["invocationCount"] == calls
                and [e["attemptId"] for e in row["events"] if e["kind"] == "invoke"]
                == ids
            )
            responses = [
                e["response"]
                for e in row["events"]
                if e["kind"] in ("reply-withheld", "reply")
            ]
            assert responses == (["lost"] if delayed else ["lost", "success"])
            assert (
                json.loads(ET.parse(out / "junit.xml").findtext(".//system-out"))[
                    "events"
                ]
                == row["events"]
            )
            boundary = checkpoint(database, out / "at-verdict.sqlite")
            assert boundary["uniqueOperationIndex"] == deduplicate
            assert [j["attempt_id"] for j in boundary["jobs"]] == ids
            expected_effects = {"duplicate": 2, "deduplicated": 1, "delayed": 0}[name]
            # The runner may stop on excess as soon as the receipt commits, before
            # Backburner's watcher observes the worker exit. FAIL does not require finality.
            assert all(r["operation_key"] == key for r in boundary["receipts"])
            assert (
                len(boundary["receipts"])
                == row["events"][-1]["entry"]["effects"]
                == expected_effects
            )
            prior = next(
                e["entry"] for e in row["events"] if e["kind"] == "before-retry"
            )
            assert prior["settledAttemptIds"] == ([] if delayed else ids[:1])
            if delayed:
                assert (
                    boundary["jobs"][0]["status"] == "working"
                    and not boundary["deliveries"]
                )
                assert row["events"][-1]["entry"]["settledAttemptIds"] == []
            else:
                assert [d["attempt_id"] for d in boundary["deliveries"]] == ids
                if deduplicate:
                    assert len({d["receipt_id"] for d in boundary["deliveries"]}) == 1
                    assert row["events"][-1]["entry"]["settledAttemptIds"] == ids
            release_started = time.time() if delayed else None
            gate.unlink(missing_ok=True)
            wait_for(
                lambda: set(
                    json.loads(ledger.read_text())["operations"][key][
                        "settledAttemptIds"
                    ]
                )
                == set(ids),
                [server, exporter],
            )
            final = checkpoint(database, out / "after-settlement.sqlite")
            assert all(
                j["status"] == "completed" and j["exit_code"] == 0
                for j in final["jobs"]
            )
            assert [d["attempt_id"] for d in final["deliveries"]] == ids
            assert len(final["receipts"]) == (1 if delayed else expected_effects)
            if delayed:
                assert (
                    cli_returned <= release_started <= final["jobs"][0]["finished_at"]
                )
            replay = run_cli(["report", report_file], expected_exit)
            (out / "replay.txt").write_text(replay)
            write(
                out / "database.json",
                {
                    "cliExit": expected_exit,
                    "replayExit": expected_exit,
                    "cliReturnedAt": cli_returned,
                    "gateReleaseStartedAt": release_started,
                    "atVerdict": boundary,
                    "afterSettlement": final,
                },
            )
            print(
                f"{name}: {expected_status} exit={expected_exit} jobs={calls} receipts={expected_effects} "
                f"finalReceipts={len(final['receipts'])} replay={expected_exit}",
                flush=True,
            )
        finally:
            # Release our bounded worker even on an assertion or CLI error.
            gate.unlink(missing_ok=True)


if __name__ == "__main__":
    if not __debug__:
        raise RuntimeError("Run with Python assertions enabled.")
    out = ROOT / "artifacts" / "backburner" / ("run-" + uuid.uuid4().hex)
    out.mkdir(parents=True)
    print(f"Evidence: {out}", flush=True)
    for item in [
        ("duplicate", "FAIL", 1),
        ("deduplicated", "PASS", 0),
        ("delayed", "INCONCLUSIVE", 3),
    ]:
        run_case(*item, out)
    write(
        out / "environment.json",
        {
            "upstream": "backburner-mcp",
            "version": version("backburner-mcp"),
            "mcp": version("mcp"),
            "python": platform.python_version(),
            "sqlite": sqlite3.sqlite_version,
            "node": subprocess.check_output(["node", "--version"], text=True).strip(),
            "platform": platform.system(),
            "arch": platform.machine(),
            "transport": "loopback Streamable HTTP",
        },
    )
