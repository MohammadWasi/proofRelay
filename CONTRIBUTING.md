# Contributing

Use Node 24.18 or newer and pnpm 11.25.0. Run `pnpm install`, `pnpm check`, and `pnpm audit:licenses` before a pull request. Tests use temporary workspaces and deterministic fixtures; never require paid providers in CI.

Keep domain changes small and explicit. Add regression evidence for state transitions, approval boundaries, installer writes, or process lifecycle changes. Treat repository contents and imported agent context as untrusted data. Do not add a telemetry endpoint or hosted service requirement.

Core package boundaries are described in [architecture](docs/architecture/overview.md). Runtime schemas are the interchange source of truth; `pnpm build` regenerates published JSON schemas. Add an ADR for compatibility or trust-boundary changes. Do not edit generated schemas alone.

Use conventional commits when practical. Record user-visible changes in CHANGELOG.md under Unreleased. Until a stable 1.0, changes to versioned portable formats still require explicit migration code and fixtures. Existing versions must fail clearly rather than being silently reinterpreted.

All contributions are Apache-2.0. Retain third-party notices. There is no contributor license agreement. Report vulnerabilities using SECURITY.md; do not post secrets in issues.
