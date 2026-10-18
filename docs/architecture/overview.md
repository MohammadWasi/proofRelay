# Architecture

The product path is **contract → approval → claim/checkpoint → submission → independent verification → portable continuation**. The CLI and MCP server use the same workspace-scoped SQLite store.

- `contracts`: strict runtime schemas, inferred types, canonical contract digests and portable format versions.
- `storage`: migrations, transactional task/event writes, leases, approval records and verification attempt fencing.
- `core`: legal state transitions, dependency validation and typed errors.
- `workflows`: service composing persistence, repository snapshots, handoffs and verification without introducing circular package dependencies.
- `security`: workspace/path checks, secret redaction, sensitive-file exclusions, fingerprints and bounded child processes.
- `verification`: approved command execution and receipts built from observed results.
- `mcp-server`: focused tools through the official MCP SDK, with no approval-granting tool.
- `cli`: local operation, trusted terminal approval, client installer and live protocol diagnostics.
- `agent-adapters`: optional provider discovery and structured events, separate from the account-free core.

## Durable ownership

Claiming is transactional. A lease contains an owner, expiry, opaque token and monotonically increasing fence. Operations from an expired claimant must fail. Recovery retains checkpoints, records an interruption, and blocks work until a local user inspects possible orphan processes and explicitly retries. It does not replay native file operations or assume they never happened. Retry limits and backoff bound orchestration retries. External side effects cannot be exactly-once merely because database changes are atomic.

## Verification

A submission is an assertion. Only the service can start an authorized verification attempt and finalize it with the internal attempt token. Receipts include approved commands, observed exit codes, sanitized output, acceptance criteria, artifact checksums, timestamps and repository fingerprints. Unavailable commands and changed repositories are inconclusive. A contract with no checkable criteria cannot pass.

## Continuity

Handoff JSON and Markdown contain explicit unfinished steps, provenance, decisions, artifact references and receipts. They contain no private model conversation formats. On retrieval, compare the saved repository fingerprint and contract digest with current values. Context is reduced within a byte budget, with a truncation warning; full history remains local. Exports are explicit exclusive writes.

## Trust boundaries

Repository text, model output, checkpoints and imports are data. None can approve commands. The trusted terminal is outside MCP but is not outside the same OS user's privileges. Local commands are not sandboxed by ProofRelay. Assist mode coordinates work performed by existing agents and cannot intercept their own tools.
