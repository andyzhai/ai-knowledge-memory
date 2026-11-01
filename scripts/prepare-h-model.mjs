import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const model = JSON.parse(await readFile(new URL('../src/search/model-manifest.json', import.meta.url), 'utf8'));
export const modelDirectory = resolve('.cache/h-model', model.id);
export function verifyAsset(bytes, file) {
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Model checksum/size mismatch: ${file.path}`);
}
export async function verifyModel() {
  for (const file of model.files) verifyAsset(await readFile(resolve(modelDirectory, file.path)), file);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const size = model.files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`H opt-in model: ${model.id}@${model.revision}; ${size} bytes. Origin: https://huggingface.co; redirects: https://us.aws.cdn.hf.co and https://*.xethub.hf.co. No library data is read or sent.`);
  if (!process.argv.includes('--download')) {
    console.log('No download performed. Pass --download to opt in. --verify checks existing assets.');
    if (process.argv.includes('--verify')) await verifyModel();
  } else {
    const log = [];
    for (const file of model.files) {
      const target = resolve(modelDirectory, file.path);
      try { verifyAsset(await readFile(target), file); continue; } catch { /* Missing/corrupt assets are replaced only after validation. */ }
      const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${file.path}`;
      let current = url, response;
      for (let hops = 0; hops < 6; hops++) {
        const parsed = new URL(current);
        if (parsed.protocol !== 'https:' || !(parsed.hostname === 'huggingface.co' || parsed.hostname === 'us.aws.cdn.hf.co' || parsed.hostname.endsWith('.xethub.hf.co'))) throw new Error('Undeclared model redirect');
        response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(300_000), credentials: 'omit' });
        log.push({ file: file.path, host: parsed.hostname, status: response.status });
        if (response.status < 300 || response.status >= 400) break;
        current = new URL(response.headers.get('location'), current).href;
      }
      if (!response?.ok) throw new Error(`Download failed: ${file.path}`);
      const parts = []; let received = 0;
      for await (const part of response.body) {
        received += part.byteLength;
        if (received > file.bytes) throw new Error(`Oversized model asset: ${file.path}`);
        parts.push(part);
      }
      const bytes = Buffer.concat(parts); verifyAsset(bytes, file);
      await mkdir(dirname(target), { recursive: true });
      const partial = `${target}.partial`;
      try { await writeFile(partial, bytes); await rename(partial, target); }
      finally { await rm(partial, { force: true }); }
      console.log(`Verified ${file.path} (${bytes.length} bytes)`);
    }
    await verifyModel(); await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/h-download.json', JSON.stringify({ model, log }, null, 2));
  }
}
