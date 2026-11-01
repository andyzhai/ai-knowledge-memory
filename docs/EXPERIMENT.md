# Optional local meaning-search experiment

The default `dist/` build is lexical-only. The separate H experiment packages a pinned multilingual MiniLM model for CPU inference and shows separately labeled **Related by meaning** suggestions. It is opt-in per view and is not enabled as a release feature.

```sh
npm run prepare:h                  # describe assets; no download
npm run prepare:h -- --download    # fetch and verify pinned model assets
npm run prepare:h -- --verify      # verify cached assets offline
npm run test:h                     # build dist-h and run packaged H tests
```

Install Playwright Chromium first as described in the [README](../README.md). Model preparation downloads approximately 135 MB from Hugging Face and its declared CDN into `.cache/h-model/`. Pinned byte sizes and SHA-256 hashes are checked. No library content is read or uploaded by preparation. A missing model fails the H build without preventing the default build.

Load `dist-h/` in a separate disposable profile. Enable **local meaning experiment for this view** explicitly. Lexical results remain available while the model loads or if inference fails. Disabling, switching to Archive, or closing the view terminates inference and discards volatile vectors. Model files remain in the installed package. No runtime download, background extraction, automatic rewriting, or persisted vector database is implemented.

`npm run test:h` produces comparison and resource reports in ignored `artifacts/`. The harness reads `tests/fixtures/evaluation-corpus.json`; comparison results do not establish user benefit or make semantic suggestions authoritative. Exact identifiers without exact matches require particular care.

[Model and runtime attribution](licenses/MODEL-NOTICE.md) accompanies the H package. Release acceptance and model-distribution review remain separate from running the experiment.
