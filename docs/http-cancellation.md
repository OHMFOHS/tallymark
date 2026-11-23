# What commits after a Streamable HTTP timeout?

Backburner 1.0.0 accepted a background job over Python Streamable HTTP. Both the current and legacy client timed out, and the Python request coroutine observed cancellation. In the independent-delay experiment the client process then exited while SQLite still showed the job working and zero receipts. The same job subsequently completed and committed one receipt. There was one outbound tool call and one inbound tool call in each run. [Current-client trace and database rows](../integrations/evidence/2026-11-22/cancellation/modern-independent-delay.json) · [Legacy-client trace and database rows](../integrations/evidence/2026-11-22/cancellation/legacy-independent-delay.json)

## Observations

Both clients used the ordinary Backburner `start_task` tool and an 800 ms SDK deadline for timed calls. The server ran the published package with Python MCP SDK 2.3.0 on a private loopback endpoint. The current TypeScript SDK 2.4.0 used auto negotiation. The separately installed official 1.32.2 client performed its own initialize handshake. The server handler and each client independently recorded the resulting protocol version. [Backburner release](https://pypi.org/project/backburner-mcp/1.0.0/) · [Legacy SDK release](https://www.npmjs.com/package/@modelcontextprotocol/sdk/v/1.32.2) · [Versioned results for all nine runs](../integrations/evidence/2026-11-22/cancellation/summary.json)

| Stage                            | Client writes / server receives, per run | Current client, protocol 2026-07-28           | Legacy client, protocol 2025-11-25                        | Final SQLite business receipts per run                                                                        |
| -------------------------------- | ---------------------------------------- | --------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| RPC held before starting the job | 1 / 1                                    | Call stream disconnected, handler cancelled   | One matching cancellation notification, handler cancelled | 0. No native job was admitted.                                                                                |
| RPC held after starting the job  | 1 / 1                                    | Call stream disconnected, handler cancelled   | One matching cancellation notification, handler cancelled | 1. A database snapshot showed a working job and zero receipts before the harness released the worker.         |
| Independent two-second workload  | 1 / 1                                    | Call stream disconnected, handler cancelled   | One matching cancellation notification, handler cancelled | 1. Zero receipts at timeout and again after the client process exited. The worker completed on its own timer. |
| Normal response, no timeout      | 1 / 1                                    | Successful response, no cancellation observed | Successful response, no cancellation observed             | 1. The harness released the working job after collecting the response.                                        |

Both SDK clients requested progress, so the timed RPC opened a real SSE response before the deadline. The kit's normal connection module was also exercised on the post-admission case. It did not request progress. Python observed the pending HTTP request disconnect before SSE headers had been sent, the RPC coroutine received cancellation, and the worker later committed one receipt. This ninth run uses the same connection and invocation code as the kit runner. [Kit connection evidence](../integrations/evidence/2026-11-22/cancellation/kit-after-admission.json)

In the recorded Node 24.22.3 independent-delay run, the legacy client timed out in 802 ms. Its cancellation targeted request 2. After that client exited, native job `97f34c32` was still working with zero receipts. Approximately 1.21 seconds later the watcher recorded completion, with one receipt linked to the same attempt. The modern client timed out in 811 ms on request 1. Its job `0e7852c7` also completed with one receipt after the client exited. The full nine-case experiment reproduced on Node 26.13.1. [Legacy evidence](../integrations/evidence/2026-11-22/cancellation/legacy-independent-delay.json) · [Modern evidence](../integrations/evidence/2026-11-22/cancellation/modern-independent-delay.json)

## How to read the evidence

- **Client.** Undici emitted the actual outgoing POST body chunks at the socket-write boundary. The collector decoded them when the body had been sent and retained method, RPC ID, attempt and cancellation target. Discovery, session cleanup and progress events are distinguished from business calls. A second dispatch would appear as a second decoded `tools/call`. [Undici diagnostics channels](https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md)
- **Server.** An ASGI wrapper observed the incoming POST bodies and recorded a disconnect only while that call's response was unfinished. An SDK middleware independently recorded a cancellation exception in the request coroutine. The client stayed connected until cancellation evidence was taken. Session deletion during subsequent cleanup was excluded. Closing a stream is the current HTTP cancellation signal. The older protocol defines a request-ID notification. [Current specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation) · [Legacy specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
- **Backend.** The business effect is one committed row in `receipts`. The upstream worker lifecycle is stored in `jobs` and `deliveries` links the attempt to the receipt. Each snapshot is a read-only SQLite backup, with its SHA-256 in the evidence. The two-second job starts its timer inside the worker. It requires no release from the harness. A backup after the operating system reports client process exit establishes the ordering independently of wall-clock precision.
- **Scope.** The harness deliberately holds the RPC before dispatch or after Backburner's native tool returns its job ID, and rethrows the SDK's actual cancellation exception. The client does not issue a separate Backburner `cancel_task` or MCP `tasks/cancel`. The result measures request cancellation and the downstream receipt for this workload. A successful experiment exit means the recorded observations matched the test expectations.

## Reproduce locally

Use a POSIX host with Node 24+ (for socket-write diagnostics), pnpm 9.15.0, uv and Python 3.13. The legacy SDK is installed only in the integration directory. Each run creates isolated databases and prints the output path.

```sh
pnpm install --frozen-lockfile
pnpm build
npm ci --prefix integrations/cancellation --ignore-scripts --no-audit --no-fund
uv sync --locked --no-install-project --project integrations/backburner
pnpm test:cancellation
```

Set `RUN` to that printed directory. These two queries show the same job working with zero receipts after client exit, then completed with one receipt:

```sh
sqlite3 -readonly "$RUN/legacy-independent-delay/after-client-exit.sqlite" 'SELECT id,status FROM jobs; SELECT count(*) FROM receipts;'
sqlite3 -readonly "$RUN/legacy-independent-delay/final.sqlite" 'SELECT id,status FROM jobs; SELECT count(*) FROM receipts;'
```

The local run retains the complete client and server event logs, database backups and per-case evidence JSON. The repository and packed candidate include the redacted per-case JSON and versioned summary. [Client instrumentation](../integrations/cancellation/client.mjs) · [Python HTTP service](../integrations/backburner/cancel_server.py) · [Experiment and assertions](../integrations/backburner/cancellation.py)
