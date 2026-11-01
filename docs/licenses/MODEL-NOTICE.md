# H experimental model and runtime attribution

Packaged only by `npm run build:h`, following explicit `npm run prepare:h -- --download`.

- Model: [sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2), Apache-2.0 according to its upstream model card; 384 dimensions, mean pooling. The upstream license text is reproduced as `MODEL-LICENSE`.
- ONNX conversion: [Xenova/paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/tree/2c4055b12046f11709e9df2c122e59ffbdc2f900), revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`; q8 weights. Files are copied unchanged. SHA-256 and sizes are pinned in `src/search/model-manifest.json`.
- Transformers.js 4.3.1: Hugging Face, Apache-2.0, `TRANSFORMERS-LICENSE` and generated `semantic-worker-LICENSES.md`.
- ONNX Runtime Web `1.31.0-dev.20260914-8d85527a0`: Microsoft Corporation, MIT; `ONNX-LICENSE` obtained from [upstream](https://github.com/microsoft/onnxruntime/blob/main/LICENSE). CPU-only WASM factory/binary are copied unchanged; the build selects the WASM-only JavaScript entry instead of the unused GPU bridge.
- Other bundled JavaScript: see generated license notices. The lockfile pins dependencies; `npm run licenses -- --h` generates `artifacts/licenses/h/dependencies.json`, which records the development dependency inventory as well.

The experiment does not establish Chrome Web Store approval or authorize a release. Model distribution/license and current store requirements are rechecked at R if this optional feature is selected.
