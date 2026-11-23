"""Mount the installed Backburner server with attempt correlation for one private run."""

import os
import re
import socket
import sys
from dataclasses import replace
from pathlib import Path

import uvicorn

COMMAND = "python3 -I worker.py"
META = "mcp-reliability-kit/attempt-id"


async def correlate(ctx, call_next):
    if ctx.method != "tools/call":
        return await call_next(ctx)
    params = ctx.params or {}
    args = params.get("arguments", {})
    key = args.get("cwd")
    attempt = params.get("_meta", {}).get(META)
    if (
        params.get("name") != "start_task"
        or args.get("command") != COMMAND
        or args.get("timeout_seconds") != 20
        or not isinstance(key, str)
        or not re.fullmatch(r"op-[0-9a-f]{24}", key)
        or not isinstance(attempt, str)
        or not re.fullmatch(re.escape(key) + r"\.[1-4]", attempt)
    ):
        raise ValueError("Expected the fixed local workload and a matching attempt ID.")
    # Backburner records the working directory when it admits the job. Carry the
    # received ID there for both the native job row and the child process.
    directory = Path(os.environ["BACKBURNER_HOME"]) / "attempts" / attempt
    directory.mkdir()
    (directory / "worker.py").symlink_to(
        Path(__file__).with_name("worker.py").resolve()
    )
    args = {**args, "cwd": str(directory)}
    return await call_next(replace(ctx, params={**params, "arguments": args}))


if __name__ == "__main__":
    if len(sys.argv) != 3 or not os.environ.get("BACKBURNER_HOME"):
        raise SystemExit("Run validate.py to start an isolated Backburner instance.")
    # Importing the upstream server initializes its job store and marks orphans.
    # Only do so after the harness has selected its own new temporary database.
    home = Path(os.environ["BACKBURNER_HOME"]).resolve()
    if (
        home != Path.cwd()
        or not (home / "attempts").is_dir()
        or not (home / "jobs.db").is_file()
    ):
        raise SystemExit("Missing the isolated validation directory.")
    from backburner.server import manager, mcp

    mcp.middleware.append(correlate)
    app = mcp.streamable_http_app(streamable_http_path=sys.argv[2], stateless_http=True)
    try:
        with socket.socket(fileno=int(sys.argv[1])) as listener:
            uvicorn.Server(uvicorn.Config(app, log_level="warning")).run(
                sockets=[listener]
            )
    finally:
        for job in manager.list():
            if job.status == "working":
                manager.cancel(job.id)
