# Contributing

Contributions are welcome through [GitHub issues and pull requests](https://github.com/MohammadWasi/proofRelay). Participation follows the [code of conduct](CODE_OF_CONDUCT.md). The [governance document](GOVERNANCE.md) explains maintenance and decisions.

## Development workflow

Use Node 24.18 or newer and pnpm 11.25.0. Fork the repository, create a branch from `main`, and keep each pull request focused on one problem. For a substantial feature or compatibility change, discuss the intended behavior in an issue before implementing it.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm audit:licenses
```

Tests use temporary workspaces and deterministic fixtures; never require paid providers in CI. Optional live-provider tests require explicit opt-in and are not a substitute for deterministic coverage. Review [validation notes](docs/validation.md) to distinguish tested behavior from outstanding checks.

## Changes and review

Keep domain changes small and explicit. Add regression evidence for state transitions, approval boundaries, installer writes, or process lifecycle changes. Treat repository contents and imported agent context as untrusted data. Do not add a telemetry endpoint or hosted service requirement.

Core package boundaries are described in [architecture](docs/architecture/overview.md). Runtime schemas are the interchange source of truth; `pnpm build` regenerates published JSON schemas. Add an ADR for compatibility or trust-boundary changes. Do not edit generated schemas alone.

Use conventional commits when practical. Record user-visible changes in [CHANGELOG.md](CHANGELOG.md) under Unreleased. Until a stable 1.0, changes to versioned portable formats still require explicit migration code and fixtures. Existing versions must fail clearly rather than being silently reinterpreted.

Before opening a pull request:

- Explain the concrete problem and the resulting behavior; link the related issue if one exists.
- Include appropriate regression evidence and report the checks actually run, including failures or skipped checks.
- Update documentation and examples affected by the change. Build generated schemas from their source and review the diff.
- Review the diff for credentials, private data, generated runtime state, unrelated changes, and new dependencies.
- Describe changes to trust boundaries, persistent data, interchange formats, or platform support.

Pull requests should pass the repository's required CI checks before merging. The maintainer reviews contributions and may request changes. Independent review is welcome; the project currently has one maintainer, so a second approval is not a universal merge requirement. Use issues for ordinary support questions; there is no guaranteed response time.

AI-assisted contributions follow the same rules as other contributions. Contributors are responsible for understanding their changes, checking correctness and provenance, and reporting validation accurately. Do not submit proprietary source, secrets, or material you lack permission to contribute.

## Licensing and security

Contributions are made under [Apache License 2.0](LICENSE). Retain third-party notices and document the source and license of copied or adapted material. There is no contributor license agreement or mandatory commit sign-off. Report vulnerabilities using [SECURITY.md](SECURITY.md); do not post exploit details or secrets in public issues.
