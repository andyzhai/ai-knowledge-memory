import { env, pipeline } from '@huggingface/transformers';
import model from './model-manifest.json' with { type: 'json' };
import { EMBEDDING_SIGNATURE, type EmbeddingProvider } from '../shared/semantic';
import { verifyModelAsset } from './asset-integrity';

export async function loadEmbeddingProvider(): Promise<EmbeddingProvider> {
  const base = new URL(/* @vite-ignore */ './models/', import.meta.url).href;
  const verified = new Map<string, ArrayBuffer>();
  // Only packaged bytes. CSP permits self, never a remote model/runtime origin.
  for (const file of model.files) {
    const url = `${base}${model.id}/${file.path}`;
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('Packaged model is unavailable.');
    const buffer = await response.arrayBuffer(); await verifyModelAsset(buffer, file); verified.set(url, buffer);
  }
  env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = base;
  env.useBrowserCache = false; env.useFSCache = false; env.useWasmCache = false;
  env.useCustomCache = true;
  env.customCache = { match: async request => {
    const bytes = verified.get(request);
    return bytes ? new Response(bytes) : undefined;
  }, put: async () => {} };
  const wasm = env.backends.onnx.wasm!;
  wasm.numThreads = 1; wasm.proxy = false;
  wasm.wasmPaths = { mjs: new URL(/* @vite-ignore */ './runtime/ort-wasm-simd-threaded.mjs', import.meta.url).href,
    wasm: new URL(/* @vite-ignore */ './runtime/ort-wasm-simd-threaded.wasm', import.meta.url).href };
  const extractor = await pipeline('feature-extraction', model.id, { device: 'wasm', dtype: 'q8', local_files_only: true });
  verified.clear();
  const tokenCount = (text: string) => extractor.tokenizer.encode(text).length;
  return { signature: EMBEDDING_SIGNATURE, dimensions: model.dimensions, tokenCount,
    async embed(text) {
      if (tokenCount(text) > 128) throw new Error('Embedding input exceeds the checked token limit.');
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data, Number);
    } };
}
