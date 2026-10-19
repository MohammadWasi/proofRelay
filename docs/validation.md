# Observed validation — 2026-10-19

## npm beta preparation

For `0.1.0-beta.1`, `pnpm check` passed typechecking, lint, build/schema generation and **71 tests, with 2 explicitly gated skips across 9 test files**. The added regression checks that the CLI version and actual MCP handshake match the root package version. `pnpm audit` reported no known vulnerabilities; the runtime license inventory still contains 17 packages.

A fresh source copy without `dist` reproduced the original packaging defect: both executables were absent from `npm pack --dry-run`. After adding the `prepack` build, another fresh source copy ran `pnpm install --frozen-lockfile` and `npm pack` without a separate build command. Its tarball included both executable entry points. A separate consumer installed that tarball using `npm install --ignore-scripts --omit=dev`, with no build tools required, then passed version/help checks, SQLite initialization, both client configuration installers, durable task creation/readback and the real MCP `doctor` check (13 tools and a successful `relay_get_status` call). These preparation checks do not assert registry publication or live model execution.

## Initial implementation validation

Local environment: macOS, Node **24.18.0**, pnpm **11.25.0**. The repository began empty and was initialized locally. The local checks below preceded public repository creation. The source was subsequently pushed to [MohammadWasi/proofRelay](https://github.com/MohammadWasi/proofRelay) with explicit user authorization. No registry packages were published, real client settings modified, or model requests made during these checks.

## Automated gate

`pnpm check` completed successfully: strict TypeScript checking, ESLint, both bundled entry points, JSON schema generation, and **70 passed / 2 skipped tests across 9 test files**. The skipped tests are explicitly gated native Codex discovery and live Codex model execution. Native discovery was then run separately, as described below. Live model execution remains unverified.

| Required scenario | Actual proof |
| --- | --- |
| A: Setup | Installer fixtures preserve unrelated JSON/TOML, back up existing files privately, refuse conflicting/symlinked paths, and prove idempotency, dry-run, project/user scopes and uninstall. |
| B: Continuity | A real MCP subprocess records a Claude-attributed checkpoint and decision; a newly connected Codex-attributed SDK client retrieves the same durable handoff. These are protocol clients, not model runs. |
| C: Verification | A completion claim is submitted, but an approved Node command actually exits 7; the receipt records the failure and state is not passed. Other checks demonstrate actual successful exits and inconclusive unavailable checks. |
| D: Interruption | An actual claimant Node process is killed after checkpointing; restart retains progress without completion evidence. Lease/verification recovery fences stale tokens and blocks retry pending inspection. |
| E: Concurrency | Two independent Node processes race for one SQLite claim; exactly one succeeds. |
| F: Secrets | Sensitive-looking notes are redacted, `.env` artifact references are excluded, byte limits produce valid bounded JSON, and exports refuse replacement. |
| G: Missing providers | Deterministic diagnostic fixtures cover missing tools; all local CLI/MCP operations run without provider credentials. Claude is absent in the observed local environment. |
| H: CLI/MCP | CLI-created tasks are visible through real SDK STDIO requests; MCP checkpoints are visible in a separate CLI process. |

Additional regressions cover human approval absence from MCP, noninteractive approval rejection, exact contract digest binding, stale repository evidence, changed HEAD, dependency cycles/readiness, retries/backoff, imported-authority rejection, process timeouts, request cancellation, disconnected clients, SIGTERM shutdown and persisted cancellation receipts.

`pnpm audit --prod --audit-level high` reported **no known vulnerabilities**. `pnpm audit:licenses` reviewed **17 runtime packages**, with Apache-2.0, MIT, ISC and BSD-3-Clause licenses. These are advisory/license checks, not a comprehensive security audit. Updating `smol-toml` to 1.9.1 removed the discovered advisories; an installer regression caused by its hardened object prototypes was fixed and tested.

## Clean installation and distribution

A separate source copy excluded `.git`, `node_modules`, `dist`, `.proofrelay` and tarballs. In that copy, `pnpm install --frozen-lockfile` installed 147 packages successfully in 1.2 seconds using the existing package-manager download cache and fresh `node_modules`. `pnpm check` then passed all gates and the same 70 tests (2 explicit skips). Vitest reported 4.86 seconds. These timings are local cached measurements, not promises for a first network download.

`pnpm pack` produced a local tarball. A fresh directory installed it through `npm install --ignore-scripts --omit=dev`. The installed runtime, outside the source checkout, successfully initialized SQLite, created both Claude/Codex configuration entries in a fixture workspace, created and reread a durable task, and ran `doctor`: **13 tools discovered and `relay_get_status` successfully invoked**. No global package was installed and no registry publication occurred. The source demo also ran successfully. Packaging uses external runtime dependencies, whose license files remain in their installed packages.

## Native client evidence

Codex **0.160.0** supports the probed structured/read-only flags and reports existing authentication. An isolated fixture with its own `CODEX_HOME` and trusted temporary Git repository passed:

```sh
PROOFRELAY_NATIVE_CODEX=1 pnpm exec vitest run tests/integration/installer.test.ts
```

All **12 installer tests passed** in that run. Native `codex mcp list --json` and `codex mcp get proofrelay --json` returned the correct enabled STDIO entry and absolute executable/server/workspace arguments. The fixture proved that discovery did not launch the server. Real server discovery and invocation are separately proven by SDK protocol tests and the `doctor` command.

Claude Code is not installed here. Its configuration formats and installer behavior are fixture-tested against fetched official documentation, but native Claude discovery and model-driven tool invocation were not run. Neither provider has performed a live managed task or real cross-provider continuation in this implementation session. Milestone 2 is incomplete.

## Reproduction and setup friction

Run `pnpm install --frozen-lockfile`, `pnpm check`, then `pnpm demo`. The demo was executed successfully: it created an isolated project and printed valid task, handoff and approval IDs. Independent commands run only after the user performs the printed terminal approval step; automated verification fixtures separately prove actual pass/fail behavior.

After building, normal setup uses four commands: `init`, `connect --dry-run`, `connect`, `doctor`. Each installed client may additionally require restart and a native project/MCP trust prompt. Execution adds one review/digest confirmation per new contract version. This is measurable setup work, not zero-friction onboarding. Tool downloads, provider installation, authentication, and native trust time are not included in local test durations.

The [first hosted CI run](https://github.com/MohammadWasi/proofRelay/actions/runs/39156468033), for initial commit `e63cd78`, passed the Linux, macOS and Windows check jobs and the dependency audit job. This confirms the configured checks on those runners, not every operating-system behavior. Native Windows managed execution remains disabled; local verifier cleanup has the documented direct-child limitation. Later revisions must independently pass their own CI run.
