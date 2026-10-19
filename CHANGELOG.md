# Changelog

All notable user-visible changes are recorded here. Format versions are tracked separately from package versions. Releases follow semantic versioning, with explicit migration notes for portable format changes.

## Unreleased — 0.1.0-beta.1

- Initial local coordination engine with versioned contracts, SQLite persistence, leases, approval requests and independent verification receipts.
- CLI and official MCP STDIO server sharing durable checkpoints, decisions and sanitized handoffs.
- Claude Code and Codex project/user configuration installers with previews, backups and uninstall.
- Deterministic unit, concurrency and protocol integration tests; optional provider adapters.
- npm beta packaging includes the CLI, MCP server, schemas, examples and open-source documentation; a `prepack` build prevents packing without the generated executables.
- Requires Node.js 24.18 or newer. npm installation does not require pnpm.
- This is the early Assist workflow. Full Managed Execution, managed editing, automatic cross-provider repair, enforceable cost budgets and a successful live two-provider run remain incomplete. It is not independently security-audited or production-proven.
