# AI Knowledge Memory

A local-first Chrome extension for Markdown notes, selected ChatGPT excerpts, loaded-conversation archives, and local search. Notes retain revision history and source references. Canonical JSON backups support restore; Markdown exports support reading elsewhere.

The default build has no backend, API key, analytics, model, or remote runtime assets. ChatGPT integration requires explicit enablement and optional site permission. Gemini and Perplexity are not implemented. Live-site compatibility and native permission flows still require manual acceptance; evaluate with synthetic content in a disposable profile.

## Build and test

Use Node **24.x** and npm. Dependencies are pinned in the lockfile.

```sh
npm ci
npx playwright install chromium
npm run check
```

The complete browser suite also requires installed Chrome stable for synthetic capture tests. Without Chrome, run:

```sh
npm run typecheck
npm test
npm run build
npm run test:browser -- --project=chromium
```

Load `dist/` as an unpacked extension in a disposable Chrome **155+** profile. Open its toolbar side panel or extension options for the full library. Never load `.cache/authorized-extension` for ordinary use: it is a test fixture with a pre-granted host permission.

- [Usage, backup, recovery, and development-folder changes](docs/USAGE.md)
- [Contributor setup, source map, and verification commands](CONTRIBUTING.md)
- [Optional local meaning-search experiment](docs/EXPERIMENT.md)

## What it does

- Create and edit Markdown notes, tags, review metadata, and immutable revision history.
- Explicitly keep selected ChatGPT excerpts or archive a loaded conversation after reviewing its scope.
- Search Knowledge and Archive locally, with filters and source navigation.
- Review, supersede, exclude, or permanently delete retained items with dependency previews.
- Download a canonical backup, validate and preview a restore, or export notes as Markdown.

Archive captures represent loaded content, not complete provider history or unseen branches. Editing a note does not erase its original sources or revision history. Notes, backups, and exports are unencrypted. Profile loss or uninstall can destroy local data; keep a verified external canonical backup. The 200 MiB import ceiling is an input limit, not a tested capacity guarantee.

## Repository scope

This repository contains everything required to build, test, and use the extension. Generated output is ignored. `package.json` uses `private: true` to prevent accidental npm publication; that setting does not define Git hosting visibility.

Builds include generated third-party notices. The optional model/runtime notices are in [docs/licenses](docs/licenses/MODEL-NOTICE.md). An application source-code license has not yet been selected; third-party notices do not license this project's own code.
