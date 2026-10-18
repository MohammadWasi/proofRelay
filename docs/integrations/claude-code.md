# Claude Code integration

ProofRelay Assist mode uses a local MCP stdio server. ProofRelay itself needs no Anthropic account or API key; Claude Code retains its own installation and authentication requirements. The server never launches another agent as part of `connect` or `doctor`.

Build ProofRelay from source with Node.js 24.18+ and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm build
```

From the target repository, run the built CLI (replace `/path/to/proofRelay` with your checkout):

```sh
node /path/to/proofRelay/dist/cli.js init
node /path/to/proofRelay/dist/cli.js connect --clients claude --dry-run
node /path/to/proofRelay/dist/cli.js connect --clients claude
node /path/to/proofRelay/dist/cli.js doctor
```

The installer adds only `mcpServers.proofrelay` to the project's `.mcp.json`, using absolute paths for the Node executable, server, and workspace. Existing unrelated entries survive. A different entry already named `proofrelay` is a conflict and must be reviewed manually. These local executable paths are machine-specific; teammates should run their own installer rather than assuming your paths exist on their computers.

Restart Claude Code from that repository, complete its native project/MCP trust prompt, and inspect `/mcp`. Ask the assistant to invoke `relay_get_status`, then retrieve a task created through the CLI with `relay_get_work`. This checks native discovery and invocation in addition to `doctor`, which independently performs an actual SDK protocol handshake, lists tools, and calls `relay_get_status`.

The [official MCP guide](https://code.claude.com/docs/en/mcp) documents project `.mcp.json` and user `~/.claude.json`. For explicitly user-scoped configuration, add `--scope user` to preview and installation. That server is pinned to the selected workspace, so project scope is preferable for independent repositories. A custom `CLAUDE_CONFIG_DIR` is not automatically modified; use project scope or review the custom location manually.

To remove the matching entry:

```sh
node /path/to/proofRelay/dist/cli.js uninstall --clients claude --dry-run
node /path/to/proofRelay/dist/cli.js uninstall --clients claude
```

Repeat `--scope user` if that was the installed scope. Backups are private files in `<scope-root>/.proofrelay/config-backups/`; `init` ignores the project `.proofrelay/` directory. Backups may contain credentials from existing configuration. Uninstall leaves backups and unrelated settings intact. Restore a backup only after reviewing any subsequent changes to the configuration file. Configuration replacement is atomic per file; installing both clients is not a cross-file transaction.

An optional [portable skill](../../packages/skills/README.md) teaches the continuity workflow. No changes to `CLAUDE.md` are required.

## Validation and current limits

Automated fixture tests exercise project and user paths, preservation, backups, idempotency, conflicts, symlink rejection, dry-run, and uninstall. Claude Code was not installed in the development environment, so native Claude discovery and a live Claude model/tool call were **not exercised**. The steps above follow fetched official documentation and tested configuration formats, not a claimed live-client demonstration.

[Programmatic Claude output](https://code.claude.com/docs/en/headless) supports newline-delimited JSON, and ProofRelay includes normalization tests for these events. Managed Claude launch is deliberately disabled until an enforceable OS isolation backend is implemented. Read-tool permissions alone do not provide OS containment.
