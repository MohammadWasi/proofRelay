# Local continuity demonstration

From the repository root: `pnpm install && pnpm build && pnpm demo`.

The script creates a temporary project, initializes SQLite, adds a structured work contract, records a Claude-attributed checkpoint and decision, and creates a common handoff. It prints exact commands with the generated IDs. These agent names are explicit demonstration attribution; the script does not invoke either model.

Run the printed `get-handoff` command to inspect the unfinished work. Run `approve` yourself in a terminal, review the executable and arguments, type the displayed digest confirmation, then run `verify`. Node executes `check.cjs`; the receipt records the real exit code and output. To demonstrate refusal of a false success claim, change `sum.cjs` to `module.exports = () => 0` before verification and observe a failing receipt.

To connect actual assistants to this temporary project, use the printed workspace with `connect --clients claude,codex`. In either client, ask it to retrieve the task using `relay_get_work` and `relay_get_handoff`. A Claude checkpoint is readable by Codex and vice versa because both use the same local database. Approval and configured independent checks remain separate from agent completion claims.
