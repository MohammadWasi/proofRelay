# Governance

ProofRelay is an Apache-2.0 open-source project maintained by [@MohammadWasi](https://github.com/MohammadWasi). It is currently a single-maintainer project, with no foundation, elected governing body, or dedicated support team.

## Decisions and contribution

Anyone may report issues, propose changes, review pull requests, or improve documentation under the [contribution guidelines](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md). Routine changes are discussed in their issues and pull requests. Changes to architecture, portable formats, compatibility, or trust boundaries should include an architectural decision record in `docs/decisions/` describing the problem, decision, and consequences.

The maintainer is responsible for scope, review, merge decisions, releases, security response, and repository administration. Decisions should be explained in the relevant public issue or pull request unless the subject is a private security report or conduct concern. Contributors can request reconsideration by presenting new evidence or a concrete alternative.

## Repository and release policy

After initial repository publication, changes to `main` should use pull requests and passing required CI checks. Branch protection should prevent force pushes and branch deletion. The repository administrator maintains these settings; this document describes the intended policy, not proof that GitHub settings are enabled. Any necessary exception should have its reason and follow-up recorded publicly, except sensitive security details.

Independent review is encouraged. A second reviewer is not required for every change while there is only one maintainer. CODEOWNERS identifies the responsible maintainer; it is not a claim that independent review has taken place.

Releases are explicit maintainer actions following the [release checklist](docs/releases.md). CI builds and tests changes but does not automatically publish packages. Public release notes must distinguish verified behavior from unsupported or untested capabilities. The [security policy](SECURITY.md) defines the scope of security maintenance.

## Growing the maintainer team

Sustained contributors may be invited to maintain the project based on their review quality, understanding of the architecture and security boundaries, and respectful collaboration. Any appointment or change to this governance policy should be recorded in a pull request. Repository administration access should be limited to the permissions needed for the person's responsibilities.
