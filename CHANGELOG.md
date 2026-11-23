# Changelog

## 0.4.0-beta.2 candidate · 2026-11-22

- Generate a disabled, one-call HTTP observation directly from an endpoint and a discovered tool name.
- Save a correlation record before every dispatch. Use the offline journal reader to reconcile a process kill with the backend. A failed journal write stops the next dispatch.
- Verify the tested npm archive by SHA-256, from the fresh consumer installation through the manual beta workflow.

## 0.4.0-beta.1 candidate · 2026-11-22

- Run discovery-only doctor against a bundled fixture, a loopback or allowlisted HTTPS endpoint, or a reviewed local stdio target file. Doctor never invokes an advertised tool.
- Add actionable findings to terminal and JSON reports and a single-case selection for isolated reproduction. Old v3 reports can still be replayed. Suites with a maximum snapshot age use report v4 so an older reader cannot silently skip the new requirement.
- Verified file observers can opt into a publication age bound. Causal identity and terminal evidence remain mandatory for a safety PASS.
- Add a locked-consumer GitHub Actions template, private reporting guidance and a manually dispatched, protected OIDC beta release workflow. Registry publication and hosted verification are pending. [Local validation](docs/beta-validation.md)

## 0.3.0 candidate · 2026-11-21

- Add explicit observational and verified modes, one-call scenarios and a read-only Filesystem onboarding template. All positive execution-safety verdicts still require independent state.
- Require settlement checkpoints for every retry that earns a PASS. Wait for delayed exports, recognize explicitly partial snapshots and retain observed contradictions. Expose per-retry proof in the assertions.
- Use the discovered tool definition for SDK dispatch and avoid an uncounted repeat call after HTTP header mismatch.
- Record the planned case list and checkpoint completed cases on disk. Publish the report pair atomically. Historical v1 and v2 PASS results replay as INCONCLUSIVE.
- Add locked external experiments for Filesystem, Memory and Python Git, and exercise the packed CLI against all five verdicts. The CI definition covers Ubuntu and macOS across Node 22, 24 and 26. [Compatibility matrix](docs/compatibility.md)

## 0.2.0 candidate

Added terminal attempt identities, a pre-retry committed-effect check for lost responses, external cancellation verification, separate executable permission, bounded external schema validation and a tarball consumer test. [Independent review](docs/production-readiness-review.md)
