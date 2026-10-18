# Security policy

ProofRelay 0.1 is an early implementation, not independently security-audited software. Only the current release line receives fixes until a maintenance policy is established.

Report vulnerabilities through the repository host's private security advisory feature when available. If it is unavailable, open a minimal issue requesting a private contact channel without exploit details or secrets. This source checkout intentionally does not invent a maintainer email or hosted repository URL.

The coordination database and terminal approval path share your operating-system identity. They cannot defend against a malicious same-user process or a coding assistant already authorized to execute arbitrary shell commands. Human approval means a trusted user reviews the contract in their own terminal; MCP cannot grant approval.

Approved verification commands run local project code with user privileges. Executable/argument separation prevents shell interpolation, not malicious test scripts. Review scripts and dependencies before approving them. Changed scripts can change command behavior; receipts record the content fingerprint they actually observed. Use an OS sandbox for untrusted projects.

Assist mode does not mediate native filesystem/network operations of the host assistant. Git worktrees are not security sandboxes. There are no automatic uploads, deployments, pushes, merges, or telemetry.

Handoff redaction and sensitive-file exclusions reduce accidental disclosure; no pattern matcher can identify every secret. Review exports before sharing. See [security design](docs/security/README.md) for the implemented controls and limits.
