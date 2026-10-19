# Security policy

ProofRelay 0.1 is an early implementation, not independently security-audited software. Security fixes target `main` and the latest published release, if any. Older releases do not have a separate maintenance commitment. A package version in the source tree does not establish that a release has been published.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/MohammadWasi/proofRelay/security/advisories/new) to contact the maintainer, [@MohammadWasi](https://github.com/MohammadWasi), without posting the report publicly. Include the affected commit or version, environment, expected security boundary, impact, and a minimal sanitized reproduction. Never include real credentials, private source code, or user databases.

If private reporting is unavailable, open a minimal [issue](https://github.com/MohammadWasi/proofRelay/issues) requesting a private contact channel. Do not include vulnerability details or secrets in that issue. There is no guaranteed response or remediation time. The maintainer will assess reports and coordinate fixes and disclosure through the private advisory where possible.

## Security boundaries

The coordination database and terminal approval path share your operating-system identity. They cannot defend against a malicious same-user process or a coding assistant already authorized to execute arbitrary shell commands. Human approval means a trusted user reviews the contract in their own terminal; MCP cannot grant approval.

Approved verification commands run local project code with user privileges. Executable/argument separation prevents shell interpolation, not malicious test scripts. Review scripts and dependencies before approving them. Changed scripts can change command behavior; receipts record the content fingerprint they actually observed. Use an OS sandbox for untrusted projects.

Assist mode does not mediate native filesystem/network operations of the host assistant. Git worktrees are not security sandboxes. There are no automatic uploads, deployments, pushes, merges, or telemetry.

Handoff redaction and sensitive-file exclusions reduce accidental disclosure; no pattern matcher can identify every secret. Review exports before sharing. See [security design](docs/security/README.md) for the implemented controls and limits.
