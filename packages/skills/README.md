# Portable ProofRelay skill

`proofrelay/SKILL.md` follows the [Agent Skills format](https://agentskills.io/specification). Copy the directory into the target repository:

```sh
mkdir -p .agents/skills/proofrelay .claude/skills/proofrelay
cp /path/to/proofRelay/packages/skills/proofrelay/SKILL.md .agents/skills/proofrelay/SKILL.md
cp /path/to/proofRelay/packages/skills/proofrelay/SKILL.md .claude/skills/proofrelay/SKILL.md
```

Inspect existing files before copying; these commands overwrite a same-named skill. The MCP installer intentionally does not overwrite or append to `AGENTS.md`, `CLAUDE.md`, or existing skills. Keep the two skill copies in sync when updating.

[Codex discovers `.agents/skills`](https://learn.chatgpt.com/docs/build-skills); [Claude Code discovers `.claude/skills`](https://code.claude.com/docs/en/skills). Restart the client if needed and invoke the `proofrelay` skill through its native skill selector. The skill describes workflow; server-side checks enforce state transitions and approvals.
