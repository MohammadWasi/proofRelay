# ADR 0001: Local coordination with observable verification

Status: accepted for 0.1.

Use strict TypeScript, Zod and Node's built-in SQLite on Node 24.18+. This avoids native addon installation and keeps data local. SQLite WAL, a busy timeout, immediate write transactions, durable leases and fencing tokens coordinate processes on one machine. A local filesystem is required; network-mounted SQLite and distributed leases are out of scope.

Immutable contract versions describe policy; a separate WorkRecord envelope holds current state and historical events. Approvals bind the contract digest, and edited/imported contracts require fresh approval. Verification attempts carry internal tokens, so MCP cannot submit a fabricated receipt. Human approval is a CLI-only interactive action, within the same-user OS trust boundary.

Use the official MCP TypeScript SDK v2, pinned to 2.3.1 after checking official documentation and the package registry on 2026-10-18. Serve STDIO and test initialize/discovery/list-tools/tool calls using the official client SDK. No HTTP server or account is required.

Build two bundled entry points in one distributable package. Private workspace packages organize source without creating a fragile multi-package release chain. No package is published by development scripts.

Passing an approved check is evidence about that check on a repository fingerprint; it is not a security or correctness proof. Verification commands are reviewed structured executable/argument records, never model-generated shell strings. Running a project test remains execution of project code.
