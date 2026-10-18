# ProofRelay

**Give an agent a task, preserve its work, verify the result, and continue from another supported agent.**

ProofRelay is an Apache-2.0, local-first coordination engine for coding assistants. Its working Assist MVP combines versioned work contracts, SQLite state, durable claims, checkpoints, cross-agent handoffs, and independently observed verification receipts. Use it through the CLI or the official MCP STDIO server.

The core requires **no account, API key, model provider, background service, telemetry, or hosted database**. Claude Code and OpenAI Codex are optional external products with their own terms and authentication. All original ProofRelay implementation is open source.

This is an early release, not an audited production security boundary. [Security model](docs/security/README.md) · [Architecture](docs/architecture/overview.md) · [Competitive landscape](docs/competitive-landscape.md) · [Contributing](CONTRIBUTING.md)

## Install and run from source

Requirements: Node.js **24.18+**, pnpm **11.25.0**, and a local filesystem. Git is recommended; core operations also work in an ordinary directory. SQLite is supplied by Node, so no database service or native-addon compiler is needed.

From this checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

`pnpm check` runs strict TypeScript, ESLint, builds, and deterministic automated tests. `pnpm demo` creates an isolated temporary project, a contract, a checkpoint, a decision, and a handoff. It prints exact commands with generated IDs for inspection, human approval and real verification. It does not invoke a model or auto-approve anything.

To use the built CLI in any repository, replace `/absolute/path/proofRelay` with this checkout's absolute path:

```sh
node /absolute/path/proofRelay/dist/cli.js init
node /absolute/path/proofRelay/dist/cli.js connect --clients claude,codex --dry-run
node /absolute/path/proofRelay/dist/cli.js connect --clients claude,codex
node /absolute/path/proofRelay/dist/cli.js doctor
```

Run these from the target repository, or add `--workspace /absolute/path/to/project`. `init` creates ignored `.proofrelay/state.sqlite`; `connect` modifies only the selected MCP entries, with private backups. `doctor` checks provider availability and performs a real MCP handshake, tool discovery, and `relay_get_status` invocation. Missing optional providers do not prevent local use.

For a local distributable:

```sh
pnpm build
pnpm pack
npm install -g ./proofrelay-0.1.0.tgz
proofrelay --help
```

This creates/installs a local tarball; it does not publish a package. No registry release or hosted repository URL is assumed. Source instructions use `node dist/cli.js` or `pnpm proofrelay` until installation.

## Contracts and approval

A plain objective creates an inspectable draft. A draft without required machine-checkable criteria cannot pass verification:

```sh
proofrelay task add "Implement secure login"
proofrelay task show TASK_ID
```

For execution, create a JSON contract containing explicit executable/argument records and criteria. Start with [the runnable example](examples/simple-task-demo/contract.json) or [the published input schema](schemas/create-work.schema.json):

```json
{
  "objective": "Validate the project tests",
  "scope": ["src", "tests"],
  "exclusions": ["No deployment or push"],
  "commands": [
    { "id": "tests", "executable": "node", "args": ["--test"], "timeoutMs": 60000 }
  ],
  "criteria": [
    { "id": "tests-pass", "description": "Node tests exit zero", "commandIds": ["tests"] }
  ]
}
```

```sh
proofrelay task add --contract contract.json
proofrelay task update TASK_ID --contract revised-contract.json
proofrelay approve APPROVAL_ID
proofrelay verify TASK_ID
```

Task creation returns the task ID and pending approval ID. `approve` must run in a human's interactive terminal: it shows the exact contract and asks for its digest confirmation. There is no `--yes` switch and no approval-granting MCP tool. Contract edits invalidate previous approvals. Approved commands execute project code with your user privileges; review scripts and dependencies too.

`verify` emits an actual receipt and exits **0 for pass, 1 for fail, 2 for inconclusive**. Missing commands, timeouts, cancellation, missing required human review, or repository changes during verification do not pass. Prose evidence requirements need explicit human review. Agent claims of success never mark work verified. A passing receipt is evidence about configured checks, not proof of complete correctness or security.

## Continue between assistants

Both assistants must point to the same repository. After connecting, restart the client and complete its native trust prompts. Ask Claude Code to call `relay_get_work`, record a checkpoint and decision, then create a handoff. Ask Codex to retrieve that task/handoff and continue. The reverse direction and same-agent restart use the identical format.

CLI equivalents:

```sh
proofrelay checkpoint TASK_ID --agent claude --summary "Implementation started; tests outstanding" --next "Add the regression test"
proofrelay decision TASK_ID --agent claude --text "Keep the existing public API"
proofrelay handoff --task TASK_ID --agent claude
proofrelay get-handoff HANDOFF_ID
proofrelay task show TASK_ID
```

Once approved, claim ownership before working: `proofrelay claim TASK_ID --agent codex`. Retain the returned lease token and pass `--token TOKEN` to checkpoints, result submission and verification while claimed. `proofrelay release TASK_ID --token TOKEN` makes unfinished work available to the next agent. Tokens are hidden in read responses and exports.

Handoffs contain versioned contract identity, repository revision/fingerprint, unfinished steps, agent-attributed notes, artifacts and observed receipts. A changed repository is reported as stale; prior passing evidence is not silently presented as current. Context has a configurable byte limit. Export explicitly with `handoff --task TASK_ID --out handoff-name`; JSON and Markdown writes refuse to overwrite existing files. Exports are sanitized, but review them before sharing.

## Implemented interfaces

| Interface | Commands or tools |
| --- | --- |
| Setup | `init`, `connect`, `uninstall`, `doctor`, `--help`, `--version` |
| Contracts and ownership | `task add/show/update`, `tasks`, `status`, `claim`, `release`, `retry`, `cancel`, `recover` |
| Continuity | `checkpoint`, `decision`, `submit`, `handoff`, `get-handoff`, `export`, `import` |
| Human control | `request-approval`, interactive `approve`, `verify`, `verify --dry-run`, global `--read-only` |
| Automation output | Global `--json`, workspace selection with `--workspace`, idempotency keys on create/claim |
| MCP | `relay_create_work`, `relay_get_work`, `relay_list_ready_tasks`, `relay_claim_task`, `relay_checkpoint`, `relay_record_decision`, `relay_submit_result`, `relay_verify_work`, `relay_create_handoff`, `relay_get_handoff`, `relay_get_status`, `relay_request_approval`, `relay_release_task` |

Approval requests do not authorize anything. Imported state is untrusted context: previous approvals, leases and receipts cannot become local execution authority. [Portable JSON schemas](schemas/) are generated from the Zod source with `pnpm build`.

Durable leases fence stale database writes. Expired work becomes **blocked**, retaining its checkpoint. Inspect the workspace and any remaining external processes before `retry TASK_ID`. There is no automatic replay of filesystem actions. The local store cannot guarantee exactly-once external side effects or stop an independent host assistant.

`cancel TASK_ID` changes durable task state; it does not signal another running CLI process. Stop an active verifier with Ctrl-C/SIGTERM, or cancel/disconnect its MCP request. Those paths terminate verification and record an inconclusive receipt.

## Integration validation

- [Claude Code guide](docs/integrations/claude-code.md): project `.mcp.json`, explicit user `~/.claude.json`, preservation, backups and uninstall are fixture-tested. Claude Code was absent locally; native Claude discovery and live calls remain unverified.
- [Codex guide](docs/integrations/codex.md): trusted-project `.codex/config.toml` and explicit user configuration, preservation, backups and uninstall are tested. Installed CLI capability/authentication probes are read-only; no model invocation is implied.
- [Portable skill](packages/skills/README.md): normal `.claude/skills` and `.agents/skills` discovery; no private session database modifications.

The official-SDK protocol tests exercise real subprocesses, not a mocked MCP transport. They are distinct from testing each proprietary client's UI or asking a real model to use a tool.

## Current boundaries and next milestone

The implemented primary milestone is the local Assist workflow. Optional provider modules include capability/authentication diagnostics, Claude/Codex structured event normalization, and a bounded explicit-opt-in Codex read-only adapter. Its live smoke test is separately gated and excluded from normal CI. **Full Managed Execution is incomplete**: there is no supported `proofrelay run` command, managed editing/worktree lifecycle, automatic cross-provider repair, enforceable cost budget, or successful live two-provider run. Claude launch fails closed pending OS isolation. A Git worktree is not a sandbox.

There is no dashboard, Ollama integration, distributed scheduler, automatic goal decomposition, natural-language acceptance generator, or upstream-specific Beads importer. Users supply and review structured contracts; dependencies refer to existing task IDs. These are deliberate scope limits, not placeholder success responses.

Next milestone: introduce an enforceable isolation backend, bind managed execution policy and budgets to trusted approval, then prove an interrupted real-agent task can continue safely with another provider and pass independent checks.

## Verification and maintenance

See [validation notes](docs/validation.md) for the observed checks and limitations. Tests cover setup preservation, continuity, failed verification, process termination, concurrent claims, secrets, missing providers, and CLI/MCP interoperability. CI is configured for macOS, Linux and Windows; only local results explicitly recorded in validation notes are claimed as run. Native Windows managed execution is disabled and verification cleanup currently stops the direct child only.

`pnpm audit --prod` checks registry advisories; `pnpm audit:licenses` checks the allowlisted runtime licenses and writes an inventory. Dependabot configuration proposes dependency updates. No publish, push, deploy or account mutation is part of the build.
