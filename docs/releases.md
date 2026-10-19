# Release checklist

Publishing a release is an explicit maintainer decision. A successful build, a package version in `package.json`, or a local tarball is not a published release. No automatic publishing workflow is configured.

The first release is prepared as **`0.1.0-beta.1`**, an early Assist beta published to npm's **`next`** tag. Keep the incomplete Managed Execution features explicit in release notes. npm consumers require Node.js **24.18+**, but do not need pnpm; maintainers use pnpm **11.25.0** to build and validate releases.

## Prepare and validate

1. Start from the intended commit on `main` with a clean checkout. Confirm its required GitHub CI checks passed on supported platforms and review any outstanding security advisories.
2. Review the changes, compatibility impact, dependency licenses, and known limitations. Update `CHANGELOG.md` and validation notes with observed results. Do not describe skipped provider tests as passing integrations.
3. Set the intended package version and check any related examples or installation instructions. Use semantic versioning for package releases; portable contract/schema versions are separate and require explicit compatibility and migration review.
4. From a clean checkout, run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm audit:licenses`, and `pnpm audit`. Assess reported runtime/development vulnerabilities and license changes before proceeding.
5. Run `pnpm pack`. The `prepack` hook builds the executables and generated schemas automatically; it does not replace the checks in the previous step. Inspect the tarball's contents for unexpected files, local state, credentials, private paths, and missing license notices. Install that exact tarball in an isolated temporary environment and verify `proofrelay --help`, `proofrelay --version`, and the documented local workflow.
6. Confirm documentation names the supported Node/pnpm versions, security boundaries, unsupported capabilities, and the private vulnerability reporting channel. Record the source commit and a SHA-256 checksum for each published artifact.

## Publish deliberately

1. Obtain any required account or project authorization before a first package registry publication. Verify ownership of the package name and registry settings. Do not assume the GitHub repository name guarantees package-name availability.
2. Publish the exact inspected tarball, rather than rebuilding from the working directory during publication. For the first beta:

   ```sh
   npm publish ./proofrelay-0.1.0-beta.1.tgz --tag next --access public
   ```

   Confirm the registry account is authorized and complete any npm authentication or two-factor prompt in the maintainer's own terminal. Do not store registry tokens or authentication codes in the repository or release notes. Prefer registry-supported provenance when available. Trusted publishing with automatic provenance is a future setup step; no such workflow is configured or claimed for this manual release.
3. Verify the resulting package version, `next` tag, artifact integrity and public repository metadata against the inspected artifact. Install the registry version in a fresh temporary environment and repeat the CLI/local-workflow smoke checks. Do not report publication success until the registry confirms it.
4. When authorized, create the version tag and GitHub prerelease for the validated source commit. Include known limitations, migration instructions, checks performed, and artifact checksums. Do not move an existing version tag.
5. Verify download/install instructions against the published artifact and link the release from the changelog. Update any conditional installation wording only after publication succeeds, keeping local and public release records consistent.

## Problems after release

Do not move a published version tag or silently replace an artifact. Document the problem and issue a new patch release when appropriate. Use registry deprecation and security advisories when needed, and provide recovery or migration instructions for affected users. Follow [SECURITY.md](../SECURITY.md) for private vulnerability handling.
