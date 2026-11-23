# Contract v1

A suite has `version: 1`, an optional integer seed (default 1), named targets and an ordered list of unique tests. All tests run sequentially. Unknown fields, repeated YAML keys and aliases fail validation. The CLI also checks target references, effect range ordering, response sequence length and use of the correlation argument. After discovery it checks the resolved arguments against the selected tool's advertised input schema before dispatch. The JSON Schema describes the structural constraints. [Schema](../packages/contracts/schema.json) · [Runnable example](../examples/reliability.yaml)

## Targets and permissions

| Kind      | Fields                                     | Invocation                                                                                                                        |
| --------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `fixture` | `mode: safe` or `unsafe`                   | Bundled synthetic payment ledger in a fresh local directory for each case.                                                        |
| `stdio`   | `command` and optional string array `args` | Supply `--allow-external --allow-stdio`. Executable arguments are passed directly. The working directory is the config directory. |
| `http`    | `url`                                      | Supply `--allow-external --allow-url <url>` for the exact Streamable HTTP endpoint. Repeat the option for additional endpoints.   |

Every case must set `allowSideEffects: true` to dispatch a call. The template grants that permission explicitly for synthetic payments. For external testing, review the local executable, endpoint and ledger producer. External tool calls can create real, irreversible effects. Discovery alone can launch the configured stdio executable. Use trusted configurations and isolated test accounts. Annotations do not authorize execution.

## Cases

| Field                  | Meaning                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `target`, `tool` | Public report labels. Use 1–64 letters, digits, underscores, dots or hyphens. Start with a letter, digit or underscore.                  |
| `arguments`            | A JSON-compatible map. An entire string value equal to `{{operationKey}}` is replaced recursively. Each retry gets equivalent arguments. |
| `fault`                | One of the schedules below. A retry limit includes only calls after the first attempt.                                                   |
| `expectResponses`      | Ordered observations drawn from `success`, `tool-error`, `lost` and `timeout`. The length must match the planned schedule.               |
| `verify`               | `{kind: fixture}`, `{kind: file, path: ledger.json}` or `{kind: none}`. Paths are relative to the config directory unless absolute.      |
| `invariant`            | Inclusive `minEffects` and `maxEffects` after all invocations for this key have settled.                                                 |
| `requestTimeoutMs`     | SDK request timeout. Range 100–10000 ms, default 3000.                                                                                   |
| `settleTimeoutMs`      | Observation window at each pre-retry and final checkpoint. Range 50–5000 ms, default 1000.                                               |

### Execution modes

Set `mode: observational` and `verify: {kind: none}` to dispatch an authorized external call and record its reply. A matched sequence yields INCONCLUSIVE for execution safety. A definite response mismatch yields FAIL. The v1 YAML shape retains the invariant fields in observational cases. The effect assertion remains unknown.

Set `mode: verified` and supply a fixture or file observer for an execution-safety gate. This mode defaults to `retryPolicy: after-settlement`. At each potential retry, the runner waits up to `settleTimeoutMs` for all earlier attempt IDs. Without that proof the runner withholds the call. `retryPolicy: scheduled` explicitly authorizes overlap in a disposable experiment. It can expose a committed duplicate. A green result still requires settlement evidence before each retry. All policies stop on unexpected transport loss and timeout.

For old suites that omit mode, the original scheduled retry authorization is retained. External cases with no observer and no explicit observational mode still stop before dispatch. New integrations should name their mode. The report records the effective mode and policy.

### Fault schedules

| Kind            | Parameters                           | Steps                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`          | none                                 | Make one normal call without an injected fault.                                                                                                                                                                                                                                                     |
| `duplicate`     | `maxRetries: 1..3`                   | Repeat a completed successful call up to the declared count. Stop on an unexpected error or timeout.                                                                                                                                                                                                |
| `lost-response` | `maxRetries: 1`                      | Withhold a completed first SDK reply from the application, record the withholding event and issue one authorized call with the same key. A real transport error stops dispatch.                                                                                                                     |
| `timeout`       | `deadlineMs: 30..5000`               | Issue one request under this deadline. The fixture commits a payment and holds the reply until cancellation or its watchdog. For external targets, arrange a deliberately slow operation. Inspect eventual state.                                                                                   |
| `transient`     | `failures: 1..2`, `maxRetries: 1..3` | A bundled fixture rejects the first N attempts before writing a receipt. Reissue only in the scheduled failure slots and within the retry budget. The retry budget must reach recovery, with one expected tool error per injected failure followed by success. External targets skip this schedule. |

The public observation list can contain `unknown` when the SDK cannot deliver a classifiable result. It stops the schedule. The runner counts calls handed to the SDK. An invocation count alone cannot establish that a server received those calls.

## Independent file observer

Expose a small local UTF-8 JSON snapshot from a trusted component with access to the actual effect store. Write complete snapshots by atomic replacement. Initialize the file before running a test. Version 1 treats a snapshot as complete by default. An exporter refreshing a partial projection must mark the top-level snapshot `"complete": false`; it is ignored until a complete snapshot arrives. Publish a terminal ID only when all effects of that attempt are final and visible in the same snapshot. The reader treats retracted committed counts, terminal IDs, cancellation telemetry or a disappearing operation as inconsistent. An exporter that omits unseen work can defeat those checks.

```json
{ "version": 1, "operations": {} }
```

For each invocation, use the generated key supplied as a tool argument. A completed example exported by a producer could look like this.

```json
{
  "version": 1,
  "operations": {
    "op-0123456789abcdef01234567": {
      "effects": 1,
      "settledAttempts": 2,
      "settledAttemptIds": [
        "op-0123456789abcdef01234567.1",
        "op-0123456789abcdef01234567.2"
      ],
      "cancellations": 0
    }
  }
}
```

The runner places a distinct attempt ID in each call's application metadata at `params._meta["mcp-reliability-kit/attempt-id"]`. This is a kit convention. Business arguments and the application operation key remain identical across retries. Record the received ID when the invocation becomes terminal. An exporter must propagate that ID through downstream jobs and deduplicate completion notifications by ID. A legacy exporter can still produce a readable count-only snapshot. Its missing identity evidence yields INCONCLUSIVE.

`effects` is a monotonic count of committed effects, including effects later compensated. `settledAttempts` counts invocations independently witnessed as terminal. An exporter without terminal telemetry can report zero witnessed completions. `settledAttemptIds` identifies them. A PASS requires the exact expected ID set and count. `cancellations` counts independently observed cancellations for the operation. Timeout cases require one observed cancellation after settlement. A settled count of zero cancellations fails that assertion; missing telemetry leaves it inconclusive. A cancellation records receipt of the signal and carries no rollback guarantee.

The baseline requires an absent key in a readable snapshot. A known committed count above the maximum immediately disproves the invariant. A count below the minimum becomes a definite failure only after settlement. The built-in observer counts receipt rows directly. For response loss, the runner takes a separate snapshot after withholding the reply and before issuing the retry. The first attempt must already have a committed effect and a matching terminal ID for a positive replay verdict. A stale first snapshot can make the case inconclusive even if a later export catches up. A fixture configured with `verify: {kind: none}` can exercise the schedule without state evidence.

## Reproduction, reporting and limits

The v3 and v4 scenario schedule is deterministic and uses no random fault timing. The seed and case ID derive repeatable keys for isolated fixtures. External targets add a fresh random namespace to protect concurrent runs from sharing records. Reports carry the actual key, seed, scenario version, negotiated protocol, ordered runner observations, call count, redacted contract fields and assertion values. To repeat an experiment, retain the original contract and use an isolated backend. Secrets and input arguments must be supplied independently.

The runner admits up to 32 cases and requests cancellation at 120 seconds per suite and 30 seconds per case. Synchronous SDK work and operating-system I/O can delay timers. Use a process-level deadline for untrusted or stalled workloads. One tool call is in flight at a time from the client. A remote operation can outlive that call. Discovery permits eight pages with at most 512 listed tools in total. A transport message buffer or HTTP response is limited to 1 MiB, a ledger to 256 KiB, and a config to 64 KiB. The observer polls for the settlement condition until the deadline. The JSON report and JUnit are published together in a unique run directory.

Suite YAML remains at version 1. Reports and scenarios default to version 3. A suite that opts into snapshot freshness uses version 4 for every case. Older readers reject that envelope. The report command rechecks positive evidence against the saved contract and checks the planned case IDs and translates historical v1/v2 passes to INCONCLUSIVE. Replaying a file checks internal consistency; provenance depends on the artifact store. The JSON Schema and report each carry a version. Consumers should dispatch on the version before processing data. Changes to the meaning of an existing fault or invariant require a new scenario or contract version.

## Beta report details and snapshot freshness

A file verifier can set `maxAgeMs` (1 through 86400000). When set, each complete snapshot must include a UTC ISO 8601 `publishedAt` value from the exporter. A missing, invalid, future or expired timestamp makes that snapshot unavailable. Accepted baseline, pre-retry and final events record `ageMs`; the beta report reader checks the bound again against those recorded ages. An old file observer remains usable without the optional bound. Publication age measures the exporter's clock and cadence. A producer that reads a stale replica and stamps it with the current time can still misreport the source. Use a trusted transaction boundary and mark lagging projections incomplete.

The beta JSON envelope adds a derived `findings` array. Each version 1 finding identifies its case, mode, tool, schedule, declared bound, replies and indexed state events. Severity describes the demonstrated contract impact. A witnessed excess or commit during a declared pre-commit rejection is high, other established violations are medium, and unresolved or operational outcomes are unassessed. Monetary impact and upstream defect status require separate evidence. Replay derives explanations from the saved events and contract projection and ignores persisted prose. Version 4 enables publication-age checks in replay. Existing v3 reports continue to use the earlier contract. A filtered run records only its selected case under `planned`.
