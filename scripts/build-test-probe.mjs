import { build } from 'vite';
import { cp, readFile, writeFile, mkdir } from 'node:fs/promises';
await build({
  configFile: false, publicDir: false,
  build: {
    target: 'chrome155', outDir: '.cache/test-probe', emptyOutDir: true,
    lib: { entry: 'src/capture/selection.ts', name: 'SelectionProbe', formats: ['iife'], fileName: () => 'selection.js' },
  },
});
// Native optional-host prompts are not DOM dialogs. Keep the production manifest
// untouched; this clearly labeled fixture provides the one host for integration
// tests of registration/injection/disable after consent. It does NOT test consent.
await mkdir('.cache/authorized-extension', { recursive: true });
await cp('dist', '.cache/authorized-extension', { recursive: true });
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
manifest.name += ' — AUTHORIZED TEST FIXTURE';
manifest.host_permissions = ['https://chatgpt.com/*'];
await writeFile('.cache/authorized-extension/manifest.json', JSON.stringify(manifest, null, 2));
