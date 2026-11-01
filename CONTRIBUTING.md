# Contributing

Use Node 24.x, install with `npm ci`, and follow the [README](README.md) to build and run checks. No sibling repository is required. Use synthetic data and disposable browser profiles.

## Source map

| Directory | Where to start |
|---|---|
| `src/ui/` | React library and side panel; navigation, editors, search and settings |
| `src/background/` | Extension service worker, sender authorization, command handling and view coordination |
| `src/content/`, `src/capture/` | ChatGPT controls and projection of loaded/selected DOM content |
| `src/storage/` | Canonical IndexedDB data and transactional operations |
| `src/search/` | Rebuildable local search and optional semantic workers |
| `src/shared/` | Types, validation, formatting and command contracts |
| `tests/` | Unit tests, packaged browser tests and authored fixtures |
| `scripts/` | Build, package audit, model preparation and evaluation tools |

Keep storage access behind the background/storage boundary. Preserve sender checks and explicit capture consent. Do not put provider HTML directly into extension pages. Maintain backup compatibility and recovery semantics when changing persistent data.

## Verification

| Command | Purpose |
|---|---|
| `npm run typecheck` | TypeScript checks |
| `npm test` | Unit tests |
| `npm run build` | Build `dist/`, generate bundled notices and audit the package |
| `npm run test:browser` | Build the test probe and run packaged Chromium/Chrome tests; build `dist/` first |
| `npm run check` | Typecheck, unit tests, build and complete default browser suite |
| `npm run evaluate:lexical` | Evaluate the fixed synthetic corpus |
| `npm run licenses` | Generate `artifacts/licenses/default/dependencies.json` |
| `npm run licenses -- --h` | Generate `artifacts/licenses/h/dependencies.json` |
| `npm run measure:a6` | Optional synthetic backup resource probe after building |

For a focused browser run: `npm run test:browser -- tests/browser/navigation.spec.ts --project=chromium`.

Browser tests use newly created disposable profiles and authored local HTML. `.cache/authorized-extension` is a labeled test-only copy with a pre-granted ChatGPT host permission. It does not test Chrome's native optional-permission prompt. Chrome-stable capture tests are synthetic DOM tests, not live-provider validation.

Generated reports and screenshots go into ignored `artifacts/` and `test-results/`; navigation screenshots use `artifacts/screenshots/navigation/`. Builds use `dist/` and `dist-h/`. Browser profiles and model assets use `.cache/`. Do not commit these outputs.

The fixed evaluation corpus is `tests/fixtures/evaluation-corpus.json`. Preserve its development/holdout distinction; do not tune against holdout labels. See the [experiment guide](docs/EXPERIMENT.md) for optional model preparation and tests.

## Manual acceptance

Before claiming release readiness, verify native permission grant/revocation, live ChatGPT routes and layouts, shortcuts, accessibility, and realistic library sizes. Automated checks do not establish those results. Use the [usage and recovery guide](docs/USAGE.md) when changing installations or troubleshooting storage.
