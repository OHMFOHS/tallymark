# Security

The CLI launches explicitly authorized local executables with the current user's privileges. Review their command and arguments, use a disposable account or sandbox, and give external experiments a private data directory. A stdio process can act at startup, including during discovery. HTTP access is limited to an exact endpoint and redirects are rejected. DNS, the host and the state exporter remain trust dependencies.

Treat a false PASS, a permission bypass or a secret disclosure as security-sensitive. Contact the repository owner privately through GitHub's **Security → Report a vulnerability** when private reporting is enabled. If unavailable, request a private reporting channel from the maintainer without posting technical details. Include the kit version, a synthetic minimal contract and redacted evidence. Omit credentials, private endpoints, user data and untrusted executables.

Beta support is best effort. Before public release, the maintainer must enable and test a reachable private reporting channel on the canonical repository. Reports assess a bounded experiment using a trusted exporter. Keep evidence in an access-controlled artifact store.
