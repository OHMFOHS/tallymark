"""Measure transport cancellation and later committed work with two real SDK generations."""

import json
import os
import platform
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import ExitStack, closing
from importlib.metadata import version
from pathlib import Path

from validate import HERE, ROOT, checkpoint, child, prepare_store, wait_for, write

CLIENT = ROOT / "integrations/cancellation/client.mjs"


def events(file):
    if not file.exists():
        return []
    # The child may be appending the last line while the harness polls.
    return [json.loads(row) for row in file.read_bytes().split(b"\n")[:-1]]


def select(trace, event, method=None):
    return [
        r
        for r in trace
        if r["event"] == event and (method is None or r.get("method") == method)
    ]


def measure(client, stage, out):
    out.mkdir()
    key = "op-" + uuid.uuid4().hex[:24]
    timeout = stage != "normal"
    autonomous = stage == "independent-delay"
    client_log, server_log = out / "client.jsonl", out / "server.jsonl"
    with (
        tempfile.TemporaryDirectory(prefix="mrk-cancel-") as temp,
        ExitStack() as stack,
    ):
        home = Path(temp).resolve()
        (home / "attempts").mkdir()
        gate = home / "hold"
        if autonomous:
            (home / "two-second-workload").touch()
        else:
            gate.touch()
        env, db = prepare_store(home, False)
        env.update(
            MRK_STAGE="after-admission" if autonomous else stage,
            MRK_SERVER_TRACE=str(server_log),
        )
        route = "/" + uuid.uuid4().hex + "/mcp"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            endpoint = f"http://127.0.0.1:{sock.getsockname()[1]}{route}"
            server = stack.enter_context(
                child(
                    [
                        sys.executable,
                        HERE / "cancel_server.py",
                        str(sock.fileno()),
                        route,
                    ],
                    env,
                    out / "service.log",
                    cwd=home,
                    pass_fds=(sock.fileno(),),
                )
            )
        finish = home / "finish"
        peer = stack.enter_context(
            child(
                [
                    "node",
                    CLIENT,
                    client,
                    endpoint,
                    key,
                    "800" if timeout else "5000",
                    client_log,
                    finish,
                ],
                dict(os.environ),
                out / "sdk.log",
                cwd=home,
            )
        )
        try:
            wait_for(lambda: select(events(client_log), "result"), [server, peer])
            at_result = checkpoint(db, out / "at-client-result.sqlite")
            if timeout:
                wait_for(
                    lambda: select(events(server_log), "handlerCancelled"),
                    [server, peer],
                    timeout=4,
                )
            # Take cancellation evidence while both the session and server are live.
            observed_server = events(server_log)
            after_client_exit = None
            client_exited = None
            released = None
            if autonomous:
                finish.touch()
                if peer.wait(timeout=6) != 0:
                    raise RuntimeError(
                        "Client cleanup failed during the independent delay"
                    )
                client_exited = time.time_ns() // 1000
                after_client_exit = checkpoint(db, out / "after-client-exit.sqlite")
                assert [j["status"] for j in after_client_exit["jobs"]] == ["working"]
                assert not after_client_exit["receipts"]
            else:
                released = time.time_ns() // 1000
                (home / "release-call").touch()
                gate.unlink()
            if stage != "before-admission":

                def completed():
                    with closing(
                        sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
                    ) as conn:
                        return (
                            conn.execute(
                                "SELECT count(*) FROM jobs WHERE status='completed'"
                            ).fetchone()[0]
                            > 0
                        )

                wait_for(completed, [server] if autonomous else [server, peer])
            final = checkpoint(db, out / "final.sqlite")
            if not autonomous:
                observed_server = events(server_log)
                finish.touch()
                if peer.wait(timeout=6) != 0:
                    raise RuntimeError(f"Client cleanup failed: see {out / 'sdk.log'}")
        finally:
            finish.touch()
            gate.unlink(missing_ok=True)
            (home / "release-call").touch()

    trace = events(client_log)
    before_close = trace[
        : next(i for i, r in enumerate(trace) if r["event"] == "cleanupStarted")
    ]
    [outcome] = select(before_close, "result")
    sent = select(before_close, "postSent", "tools/call")
    received = select(observed_server, "postReceived", "tools/call")
    [call] = sent
    [inbound] = received
    assert (
        call["id"] == inbound["id"]
        and call["attempt"] == inbound["attempt"] == key + ".1"
    )
    assert not select(trace, "undecodedPost")
    assert (
        len(select(trace, "postSent", "tools/call"))
        == len(select(events(server_log), "postReceived", "tools/call"))
        == 1
    )
    [handler] = select(observed_server, "handlerEntered")
    assert handler["id"] == call["id"] and handler["protocol"] == outcome["protocol"]
    legacy = client == "legacy"
    assert outcome["protocol"] == ("2025-11-25" if legacy else "2026-07-28")
    assert outcome["result"] == ("timeout" if timeout else "success")
    notifications = select(observed_server, "postReceived", "notifications/cancelled")
    outgoing = select(before_close, "postSent", "notifications/cancelled")
    assert [n["targetId"] for n in outgoing] == [n["targetId"] for n in notifications]
    assert all(n["targetId"] == call["id"] for n in notifications)
    dropped = select(observed_server, "callDisconnected")
    cancelled = select(observed_server, "handlerCancelled")
    assert all(v["id"] == call["id"] for v in dropped + cancelled)
    assert len(cancelled) == int(timeout)
    if timeout:
        if legacy:
            assert len(notifications) == 1
        else:
            assert dropped and not notifications
    else:
        assert not notifications and not dropped
    sse = any(
        "text/event-stream" in e["contentType"]
        for e in select(observed_server, "callResponseStarted")
    )
    if timeout and client != "kit":
        assert sse and select(before_close, "progress")
    admitted = stage != "before-admission"
    assert len(select(observed_server, "nativeToolReturned")) == int(admitted)
    assert not at_result["receipts"] and not at_result["deliveries"]
    assert [j["status"] for j in at_result["jobs"]] == (["working"] if admitted else [])
    assert len(final["receipts"]) == len(final["deliveries"]) == int(admitted)
    if admitted:
        [job] = final["jobs"]
        assert (
            job["id"] == at_result["jobs"][0]["id"] and job["attempt_id"] == key + ".1"
        )
        assert job["status"] == "completed" and job["exit_code"] == 0
        [receipt] = final["receipts"]
        [delivery] = final["deliveries"]
        assert receipt["operation_key"] == delivery["operation_key"] == key
        assert receipt["created_by"] == delivery["attempt_id"] == key + ".1"
        assert receipt["id"] == delivery["receipt_id"]
        if autonomous:
            assert after_client_exit["jobs"][0]["id"] == job["id"]
    result = {
        "client": client,
        "stage": stage,
        "protocol": outcome["protocol"],
        "outcome": outcome["result"],
        "deadlineMs": outcome["deadlineMs"],
        "elapsedMs": outcome["elapsedMs"],
        "operationKey": key,
        "requestId": call["id"],
        "clientSentCalls": len(sent),
        "serverReceivedCalls": len(received),
        "cancelNotificationsSent": len(outgoing),
        "cancelNotificationsReceived": len(notifications),
        "callDisconnectObserved": bool(dropped),
        "handlerCancellations": len(cancelled),
        "sseResponseOpened": sse,
        "receiptsAtClientResult": len(at_result["receipts"]),
        "receiptsAfterClientExit": len(after_client_exit["receipts"])
        if autonomous
        else None,
        "finalReceipts": len(final["receipts"]),
    }
    write(
        out / "evidence.json",
        {
            "summary": result,
            "clientEvents": trace,
            "serverEventsBeforeClientCleanup": observed_server,
            "releaseStartedAtUs": released,
            "clientProcessExitObservedAtUs": client_exited,
            "atClientResult": at_result,
            "afterClientExit": after_client_exit,
            "finalDatabase": final,
        },
    )
    print(
        client,
        stage,
        outcome["result"],
        f"sent={len(sent)} received={len(received)} cancelNotifications={len(notifications)} disconnect={bool(dropped)} handlerCancelled={len(cancelled)} receipts=0->{len(final['receipts'])}",
        flush=True,
    )
    return result


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("Python assertions must be enabled.")
    node = subprocess.check_output(["node", "-v"], text=True).strip()
    if int(node[1:].split(".")[0]) < 24:
        raise SystemExit("Use Node 24+ for the socket-write diagnostics channel.")
    out = ROOT / "artifacts/cancellation" / ("run-" + uuid.uuid4().hex)
    out.mkdir(parents=True)
    print("Evidence:", out, flush=True)
    results = []
    for client in ("modern", "legacy", "kit"):
        stages = (
            ("after-admission",)
            if client == "kit"
            else ("after-admission", "before-admission", "normal", "independent-delay")
        )
        for stage in stages:
            results.append(measure(client, stage, out / (client + "-" + stage)))
    versions = {
        "node": node,
        "modernClient": json.loads(
            (
                ROOT / "node_modules/@modelcontextprotocol/client/package.json"
            ).read_text()
        )["version"],
        "legacyClient": json.loads(
            (
                CLIENT.parent / "node_modules/@modelcontextprotocol/sdk/package.json"
            ).read_text()
        )["version"],
        "python": platform.python_version(),
        "mcp": version("mcp"),
        "backburner": version("backburner-mcp"),
        "sqlite": sqlite3.sqlite_version,
        "platform": platform.system(),
        "arch": platform.machine(),
    }
    write(out / "summary.json", {"versions": versions, "results": results})
