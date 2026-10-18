# Security model

ProofRelay is a local coordination and verification tool. Its original implementation is open source, needs no hosted control plane, and sends no telemetry. Optional proprietary coding agents are outside the core trust boundary.

## Approval and execution

Repository content, checkpoints, model output, and MCP requests are untrusted data. They cannot create an approved execution record. Approval must come from the local CLI, and binds the exact versioned contract digest. Changing a contract invalidates its execution authorization. The service checks that durable approval before starting a verification attempt; the verifier additionally requires the matching digest.

Commands are structured executable/argument arrays. ProofRelay never interpolates a model-generated shell command, sets `shell: false`, and rejects explicit shell executables and shell command wrappers. Only commands referenced by acceptance criteria run. Their exit codes and bounded, sanitized output are recorded as observations. A missing executable, rejected working directory, interrupted process, or timeout cannot produce a passing check. Empty required criteria, missing human review, unassessed prose evidence requirements, or repository drift yield an inconclusive receipt. Ordinary nonzero exits fail the applicable criterion. A passing receipt covers the configured checks and is not proof of complete correctness or security.

**An approved executable, package script, or `node -e` program is arbitrary code.** Approval authorizes that code with the user's operating-system permissions. It can read files, access the network, alter ignored files, or launch other processes. Structured arguments prevent shell interpolation; they do not make the program safe. Inspect commands and scripts before approving. Command names resolved through `PATH` trust the local executable installation. The contract digest does not freeze installed dependencies or executable contents.

The child process receives a small environment allowlist for executable discovery, user directories, temporary directories, locale, and platform support. Provider/API credentials and loader variables are not automatically inherited. This reduces accidental exposure; programs can still read credentials accessible to the current user. Test commands needing a particular environment must arrange it explicitly in reviewed project code.

## Workspace and evidence

Workspace-relative path validation rejects absolute paths, `..` traversal, escaping symlink ancestors, dangling symlinks when creating paths, and sensitive filenames. Evidence hashing resolves and checks the path, opens ordinary files without following a final symlink where the OS supports `O_NOFOLLOW`, and checks file identity and changes during hashing.

Default sensitive exclusions cover environment files (including `.env.*`), common credential files, private key/certificate containers, `secrets` directories, and local credential directories such as `.ssh` and `.aws`. Snapshots also exclude `.git`, `.proofrelay`, and `node_modules`. In Git repositories the inventory includes tracked and untracked files while respecting ignores for untracked files. The fingerprint covers sorted names, contents, and executable bits; symlinks contribute their target text without reading the target. Git revision is recorded separately. Git's optional external filesystem monitor is disabled for inventory. Without Git, the filesystem inventory uses the built-in exclusions.

Before/after fingerprints detect observable repository drift during verification. Ignored files, excluded files, files changed and restored between observations, and concurrent hostile filesystem races are outside this guarantee. Path checks and final-file checks reduce accidental escapes; they cannot provide race-free operating-system containment against another process rewriting parent directories. A Git worktree is likewise not a security sandbox.

Artifacts are hashed only when explicitly referenced, and sensitive paths are rejected before opening. Handoffs contain structured state and file references rather than automatically copying source or credential contents. Redaction recursively masks sensitive field names, common token formats, inline credential assignments, bearer tokens, private key blocks, credential-bearing URLs, and known secret environment values. Redaction is heuristic: unusually encoded or unlabeled secrets can evade it. Review portable exports before sharing them.

## Timeouts, cancellation, and cleanup

Capture defaults to a combined 64 KiB of stdout and stderr per command; receipts identify truncation. Commands have individual and overall verification timeouts. Cancellation and timeout send termination signals, then escalate to a kill. On macOS/Linux, ordinary descendants in the child's dedicated process group are also cleaned up when the leader exits. Deliberately detached descendants can escape that group. Windows currently terminates the direct child only; process-tree containment is not implemented. These are process-management controls, not sandbox enforcement.

This implementation does not claim OS isolation, network containment, protection from a malicious local administrator, or control over filesystem actions a host coding assistant performs directly. Use a separately configured OS sandbox/container or an isolated development environment for untrusted execution. Managed provider execution remains a separately authorized integration.

## Reporting vulnerabilities

Follow [SECURITY.md](../../SECURITY.md). Do not attach real secrets or private repository content to a public issue. Deterministic tests cover traversal and symlink escapes, secret redaction and exclusion, command failures, missing executables, timeout/cancellation, output bounds, process-group cleanup, untracked-file freshness, exact approval binding, evidence checksums, required human review, and verification drift.

Implementation references: [Node.js child processes](https://nodejs.org/api/child_process.html), [Node.js filesystem operations](https://nodejs.org/api/fs.html), and [Git ls-files](https://git-scm.com/docs/git-ls-files).
