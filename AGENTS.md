# Contributor and agent instructions

This is the public application repository. Keep source, automated tests, synthetic fixtures, build tooling, and public usage/contributor documentation here. It must remain independently buildable and testable.

- Prefer small, readable changes. Preserve storage, authorization, retry, and recovery behavior unless the task explicitly changes it.
- Use Node 24.x and the pinned lockfile. Do not upgrade dependencies as an incidental cleanup.
- Read `CONTRIBUTING.md` for commands and the source map. Run checks appropriate to the change and report actual outcomes.
- Keep generated builds, browser profiles, downloaded model assets, diagnostics, and test results ignored. Never use a personal browser profile for automated tests.
- Do not include credentials, real captured account data, internal plans, detailed internal design, or verification reports in public commits.
- Internal engineering documentation belongs in the paired `private-ai-knowledge-memory` repository when available. Public contributors do not need that repository. Never make build/test scripts read or write sibling repositories.
- Do not edit the historical `internal-ai-knowledge-memory` repository. Code refactoring is a separate task from the repository split.
- Do not commit, push, or change remote visibility without authorization. Review intended files before any commit.
