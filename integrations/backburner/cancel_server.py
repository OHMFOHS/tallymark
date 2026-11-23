"""Fault controls around the installed Backburner tool, plus passive ASGI observations."""

import json
import os
import socket
import sys
import time
from pathlib import Path

import anyio
import uvicorn

from server import META, correlate


def record(event, **fields):
    with Path(os.environ["MRK_SERVER_TRACE"]).open("a") as log:
        log.write(
            json.dumps({"event": event, "atUs": time.time_ns() // 1000, **fields})
            + "\n"
        )


async def hold_reply():
    with anyio.fail_after(12):
        while not Path("release-call").exists():
            await anyio.sleep(0.02)


async def deadline_control(ctx, call_next):
    if ctx.method != "tools/call":
        return await call_next(ctx)
    mode = os.environ["MRK_STAGE"]
    fields = {"id": ctx.request_id, "protocol": ctx.protocol_version}
    record("handlerEntered", **fields)
    try:
        await ctx.session.report_progress(1, 2)
        if mode == "before-admission":
            await hold_reply()
        result = await call_next(ctx)
        record("nativeToolReturned", **fields)
        if mode == "after-admission":
            await hold_reply()
        return result
    except anyio.get_cancelled_exc_class():
        record("handlerCancelled", **fields)
        raise


def observe_http(app):
    async def observed(scope, receive, send):
        if scope["type"] != "http":
            return await app(scope, receive, send)
        body = bytearray()
        rpc = {}
        done = False

        async def read():
            message = await receive()
            if message["type"] == "http.request" and scope["method"] == "POST":
                body.extend(message.get("body", b""))
                if not message.get("more_body") and body:
                    rpc.update(json.loads(body))
                    params = rpc.get("params", {})
                    record(
                        "postReceived",
                        method=rpc.get("method"),
                        id=rpc.get("id"),
                        targetId=params.get("requestId"),
                        attempt=params.get("_meta", {}).get(META),
                    )
                    body.clear()
            if (
                message["type"] == "http.disconnect"
                and not done
                and rpc.get("method") == "tools/call"
            ):
                record("callDisconnected", id=rpc["id"])
            return message

        async def write(message):
            nonlocal done
            if (
                rpc.get("method") == "tools/call"
                and message["type"] == "http.response.start"
            ):
                headers = dict(message.get("headers", []))
                record(
                    "callResponseStarted",
                    id=rpc["id"],
                    status=message["status"],
                    contentType=headers.get(b"content-type", b"").decode(),
                )
            if message["type"] == "http.response.body" and not message.get("more_body"):
                done = True
            await send(message)

        await app(scope, read, write)

    return observed


if __name__ == "__main__":
    home = Path(os.environ["BACKBURNER_HOME"]).resolve()
    if (
        home != Path.cwd()
        or not (home / "attempts").is_dir()
        or not (home / "jobs.db").is_file()
    ):
        raise SystemExit("Use the isolated cancellation harness")
    from backburner.server import manager, mcp

    mcp.middleware.extend([correlate, deadline_control])
    # A legacy notification POST must share a live session with the original call.
    app = mcp.streamable_http_app(
        streamable_http_path=sys.argv[2], stateless_http=False
    )
    try:
        with socket.socket(fileno=int(sys.argv[1])) as listener:
            uvicorn.Server(uvicorn.Config(observe_http(app), log_level="warning")).run(
                sockets=[listener]
            )
    finally:
        for job in manager.list():
            if job.status == "working":
                manager.cancel(job.id)
