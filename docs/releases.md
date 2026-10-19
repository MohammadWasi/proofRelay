# Release checklist

Publishing a release is an explicit maintainer decision. A successful build, a package version in `package.json`, or a local tarball is not a published release. No automatic publishing workflow is configured.

## Prepare and validate

1. Start from the intended commit on `main` with a clean checkout. Confirm its required GitHub CI checks passed on supported platforms and review any outstanding security advisories.
2. Review the changes, compatibility impact, dependency licenses, and known limitations. Update `CHANGELOG.md` and validation notes with observed results. Do not describe skipped provider tests as passing integrations.
3. Set the intended package version and check any related examples or installation instructions. Use semantic versioning for package releases; portable contract/schema versions are separate and require explicit compatibility and migration review.
4. From a clean checkout, run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm audit:licenses`, and `pnpm audit`. Assess reported runtime/development vulnerabilities and license changes before proceeding.
5. Run `pnpm pack`. Inspect the tarball's contents for unexpected files, local state, credentials, private paths, and missing license notices. Install that exact tarball in an isolated temporary environment and verify `proofrelay --help`, `proofrelay --version`, and the documented local workflow.
6. Confirm documentation names the supported Node/pnpm versions, security boundaries, unsupported capabilities, and the private vulnerability reporting channel. Record the source commit and a SHA-256 checksum for each published artifact.

## Publish deliberately

1. Obtain any required account or project authorization before a first package registry publication. Verify ownership of the package name and registry settings. Do not assume the GitHub repository name guarantees package-name availability.
2. Create the version tag and GitHub release for the validated commit. Use a prerelease designation when appropriate to communicate readiness, and include known limitations, migration instructions, checks performed, and artifact checksums.
3. If an npm release is intended, publish only the inspected package using the maintainer's authorized registry workflow. Prefer registry-supported provenance where available and verify the resulting metadata and artifact contents.
4. Verify download/install instructions against the published artifact and link the release from the changelog. Keep the local and public release records consistent.

## Problems after release

Do not move a published version tag or silently replace an artifact. Document the problem and issue a new patch release when appropriate. Use registry deprecation and security advisories when needed, and provide recovery or migration instructions for affected users. Follow [SECURITY.md](../SECURITY.md) for private vulnerability handling.
