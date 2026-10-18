# Codex integration

ProofRelay's local coordination engine and MCP server do not require an OpenAI account or API key. Codex's optional model execution has its own installation and authentication requirements.

Build ProofRelay with Node.js 24.18+ and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm build
```

From the target repository:

```sh
node /path/to/proofRelay/dist/cli.js init
node /path/to/proofRelay/dist/cli.js connect --clients codex --dry-run
node /path/to/proofRelay/dist/cli.js connect --clients codex
node /path/to/proofRelay/dist/cli.js doctor
```

Replace `/path/to/proofRelay` with the built source checkout. To install both clients, use `--clients claude,codex`.

The installer appends a marked `[mcp_servers.proofrelay]` block to `.codex/config.toml` and leaves existing TOML text and comments intact. The block specifies absolute executable/server/workspace paths. Conflicting entries are rejected without changing either planned client config. Do not assume those machine-specific paths work for a teammate; each developer should run the installer.

[Official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) supports `.codex/config.toml` for trusted projects and `~/.codex/config.toml` for user configuration. Restart Codex inside the repository, trust it through the native workflow, and inspect MCP availability using `/mcp` or `codex mcp list`. Ask Codex to call `relay_get_status` and retrieve an existing task with `relay_get_work`. `doctor` separately performs a real SDK stdio handshake, tool discovery, and status invocation; it does not attest that your native Codex UI loaded the configuration.

Explicit user scope uses `connect --scope user`; preview it first. The resulting server remains pinned to the workspace in which you installed it. A custom `CODEX_HOME` is not modified automatically; use project scope or configure your custom location manually. Native managed policy or project trust can restrict server availability and must be resolved in Codex, not bypassed by ProofRelay.

To remove only ProofRelay's matching, marked entry:

```sh
node /path/to/proofRelay/dist/cli.js uninstall --clients codex --dry-run
node /path/to/proofRelay/dist/cli.js uninstall --clients codex
```

Use the same `--scope user` if applicable. Backups live under `<scope-root>/.proofrelay/config-backups/` with private file permissions. `init` ignores project `.proofrelay/`. Keep backups private; they contain the original configuration. If the managed block was manually edited, uninstall fails closed rather than deleting that content. Each file replacement is atomic, but the two-client installation is not a multi-file transaction.

For workflow instructions, copy the [portable skill](../../packages/skills/README.md) to `.agents/skills/proofrelay/SKILL.md`, as described by the [official skill discovery documentation](https://learn.chatgpt.com/docs/build-skills).

## Provider adapter status

Local read-only inspection observed `codex-cli 0.160.0`, supported `exec --json`, `--sandbox read-only`, and `--cd` flags, and an authenticated login. No provider credentials were displayed. The adapter probes each installed CLI instead of assuming these capabilities from a version string.

On 2026-10-19, the installed **Codex 0.160.0** also parsed a generated project configuration in a temporary Git repository with an isolated child-process `CODEX_HOME`. Both `codex mcp list --json` and `codex mcp get proofrelay --json` exited successfully and returned `name: "proofrelay"`, `enabled: true`, transport `stdio`, and the expected Node executable, server path, and workspace arguments. The fixture's local stdio authentication status was `unsupported`, as no MCP OAuth authentication was configured. This check did not launch the server or a model and did not modify real user settings. It proves native configuration discovery, not model-driven tool invocation or desktop UI loading.

Repeat that native configuration check with an installed Codex CLI, without making a model request:

```sh
PROOFRELAY_NATIVE_CODEX=1 pnpm exec vitest run tests/integration/installer.test.ts
```

The [official non-interactive interface](https://learn.chatgpt.com/docs/non-interactive-mode) emits JSONL lifecycle/item events. ProofRelay normalizes selected fields, redacts retained text, reports only provider-observed usage, handles nonzero exits, and bounds runtime and output. Automated subprocess fixtures exercise completion, malformed output, timeout, and cancellation. These tests do not establish live provider execution.

The available adapter is a limited explicit-opt-in **read-only** path using Codex's native sandbox selection. It does not implement managed editing, a worktree lifecycle, automatic provider switching, token/cost enforcement, or an isolated provider configuration. Installed client hooks/plugins and their trust remain a host responsibility. Native Windows managed execution is disabled until process-tree isolation is implemented; WSL follows the Linux path. A Git worktree is never presented as a security sandbox. Full managed execution is a later milestone.

An optional live smoke test makes one real Codex request using your existing authentication and provider defaults. It can consume account usage and is disabled in normal tests and CI. Run it yourself only when that request is intended:

```sh
PROOFRELAY_LIVE_CODEX=1 pnpm exec vitest run tests/unit/adapters.test.ts
```

The test creates a temporary Git repository, asks for a fixed response without tools, and requires a successful structured completion. It skips when Codex is absent, unauthenticated, incompatible, or running on native Windows. A skip is not evidence of successful provider execution. There is no live Claude smoke test because managed Claude launch currently fails closed.
