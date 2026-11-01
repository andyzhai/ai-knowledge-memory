import { build } from 'vite';
import { copyFile, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { auditPackage } from './audit-package.mjs';
import { verifyModel, modelDirectory, model } from './prepare-h-model.mjs';
import { fileURLToPath } from 'node:url';

const experiment = process.argv.includes('--h');
const outDir = experiment ? 'dist-h' : 'dist';
if (experiment) await verifyModel();

const shared = {
  configFile: false,
  base: './',
  publicDir: false,
  define: { __H_EXPERIMENT__: JSON.stringify(experiment) },
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'],
    // H proves CPU first. Exclude the unused GPU/JSEP bridge and its dynamic
    // function generator; package the CSP-compatible WASM-only runtime.
    alias: { 'onnxruntime-web/webgpu': fileURLToPath(new URL('../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs', import.meta.url)) },
  },
  build: { target: 'chrome155', outDir, sourcemap: false, minify: true, modulePreload: false },
};
await build({
  ...shared,
  build: {
    ...shared.build,
    emptyOutDir: true,
    license: { fileName: 'UI-LICENSES.md' },
    rolldownOptions: { input: ['sidepanel.html', 'library.html'] },
  },
});
// Content scripts are classic scripts, not module scripts; bundle separately.
for (const [entry, name, format] of [
  ['src/background/service-worker.ts', 'service-worker', 'es'],
  ['src/content/index.ts', 'content', 'iife'],
  ['src/search/search-worker.ts', 'search-worker', 'es'],
  ...(experiment ? [['src/search/semantic-worker.ts', 'semantic-worker', 'es']] : []),
]) {
  await build({
    ...shared,
    build: {
      ...shared.build,
      emptyOutDir: false,
      license: { fileName: `${name}-LICENSES.md` },
      lib: { entry, name: 'AKMProbe', formats: [format], fileName: () => `${name}.js` },
    },
  });
}
await mkdir(outDir, { recursive: true });
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
if (experiment) {
  manifest.name += ' — H EXPERIMENT';
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages
    .replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'").replace("connect-src 'none'", "connect-src 'self'");
  await cp(modelDirectory, `${outDir}/models/${model.id}`, { recursive: true });
  await mkdir(`${outDir}/runtime`, { recursive: true });
  for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) await copyFile(`node_modules/onnxruntime-web/dist/${file}`, `${outDir}/runtime/${file}`);
  await copyFile('node_modules/@huggingface/transformers/LICENSE', `${outDir}/TRANSFORMERS-LICENSE`);
  await copyFile('node_modules/@huggingface/transformers/LICENSE', `${outDir}/MODEL-LICENSE`);
  await copyFile('docs/licenses/MODEL-NOTICE.md', `${outDir}/MODEL-NOTICE.md`);
  await copyFile('docs/licenses/ONNX-LICENSE', `${outDir}/ONNX-LICENSE`);
}
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
await auditPackage(outDir, experiment);
