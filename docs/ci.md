# Use an execution-safety gate in GitHub Actions

1. Install the kit as a locked dev dependency of your test project. While the package is unpublished, copy the reviewed local tarball into `vendor/`, run `npm install --save-dev ./vendor/mcp-reliability-kit-0.4.0-beta.2.tgz`, and include the tarball, package manifest and lockfile in that project. The workflow uses the installed executable.
2. Copy [verified.yml](../examples/ci/verified.yml) into your project's `.github/workflows/`. Its default run initializes and verifies the isolated synthetic fixture.
3. To gate a service, set the repository variable `MRK_SUITE` to a reviewed config path and provision a disposable target and exporter in an earlier step. Set `MRK_URL` to the exact HTTP endpoint, or set `MRK_ALLOW_STDIO=true` for a reviewed stdio executable. Select `mode: verified` in the case. Keep secrets out of YAML and report labels.

The template grants read-only repository access, discards checkout credentials, and uploads JSON/JUnit and interrupted-run journals even on test failure. The Actions summary includes the actual finding and next action. Preserve the CLI exit code. An expected INCONCLUSIVE in the kit's own interoperability experiments has a different purpose from an application release gate.

| Exit | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | Every executed case passed verified checks. Doctor separately returns 0 when discovery succeeds. |
| 1    | A declared contract was violated.                                                                |
| 2    | Invalid configuration, connection, report or infrastructure error. Takes precedence over 1.      |
| 3    | Unresolved INCONCLUSIVE or SKIPPED cases remain with no FAIL or ERROR. The gate stays red.       |

Inspect a saved report locally with `mcp-reliability-kit report "$REPORT_JSON"`. For a new experiment restore the original synthetic inputs and seed in a clean test store, then use the case-specific command in the finding. A case-filtered run covers only its selected case. Run the full suite for release decisions.
