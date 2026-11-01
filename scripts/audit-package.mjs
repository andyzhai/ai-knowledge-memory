import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function auditPackage(directory = 'dist', experiment = false) {
  const packageDirectory = directory;
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.deepEqual(manifest.optional_host_permissions, ['https://chatgpt.com/*']);
  assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'activeTab', 'contextMenus', 'sidePanel', 'unlimitedStorage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.match(manifest.content_security_policy.extension_pages, experiment ? /connect-src 'self'/ : /connect-src 'none'/);
  assert.equal(manifest.content_security_policy.extension_pages.includes('wasm-unsafe-eval'), experiment);
  let total = 0;
  const executables = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { await visit(path); continue; }
      total += (await stat(path)).size;
      if (!/\.(m?js|html)$/.test(path)) continue;
      const source = await readFile(path, 'utf8');
      executables.push({ path: path.slice(packageDirectory.length + 1), bytes: (await stat(path)).size, sha256: createHash('sha256').update(source).digest('hex') });
      assert(!/\beval\s*\(|new\s+Function\s*\(|https?:\/\/localhost|@vite\/client/.test(source), `Unexpected dynamic/dev code in ${path}`);
      if (path.endsWith('.html')) {
        assert.doesNotMatch(source, /<script[^>]+src=["']https?:|<link[^>]+href=["']https?:/i);
      }
      // MiniSearch's map has a local fetch() method. Exclude property calls and
      // method declarations from this direct-call heuristic. This is not a full
      // data-flow audit; CSP and scoped browser observations are separate checks.
      const directFetch = /(?<![\w.$])fetch\s*\([^)]*\)(?!\s*\{)/;
      const inference = experiment && (path.includes('/runtime/') || path.includes('semantic-worker') || path.includes('transformers'));
      if (!inference) assert(!directFetch.test(source) && !/\b(?:XMLHttpRequest|WebSocket)\s*\(/.test(source), `Unexpected direct network call in ${path}`);
    }
  }
  await visit(directory);
  for (const name of ['service-worker.js', 'content.js', 'search-worker.js', 'sidepanel.html', 'library.html']) {
    assert((await stat(`${directory}/${name}`)).isFile());
  }
  if (experiment) {
    const wasmPath = `${directory}/runtime/ort-wasm-simd-threaded.wasm`;
    executables.push({ path: 'runtime/ort-wasm-simd-threaded.wasm', bytes: (await stat(wasmPath)).size, sha256: createHash('sha256').update(await readFile(wasmPath)).digest('hex') });
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/h-package.json', JSON.stringify({ totalBytes: total, manifest, executables }, null, 2));
  }
  console.log(`Package audit passed (${total} bytes; ${experiment ? 'H: packaged inference with self-only CSP' : 'lexical: no direct network calls found'}).`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await auditPackage();
