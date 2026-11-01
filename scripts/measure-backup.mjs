// Reproducible A6 resource probe; synthetic data and a disposable profile only.
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
await mkdir('.cache/profiles', { recursive: true }); await mkdir('artifacts', { recursive: true });
const profile = await mkdtemp(resolve('.cache/profiles/a6-resource-')), extension = resolve('dist');
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const samples = [], disk = {}, timings = {}, requests = [];
let sampling = false, timer;
async function diskBytes(path) { let bytes = 0; for (const e of await readdir(path, { withFileTypes: true })) { const p = resolve(path, e.name); try { if (e.isDirectory()) bytes += await diskBytes(p); else if (e.isFile()) bytes += (await stat(p)).size; } catch { /* Chrome can rotate temporary files while measured. */ } } return bytes; }
try {
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'), id = new URL(sw.url()).host;
  const page = await context.newPage(); await page.goto(`chrome-extension://${id}/library.html`); await page.getByRole('heading', { name: 'Backup and restore' }).waitFor();
  context.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); }); await context.setOffline(true);
  const cdp = await context.browser().newBrowserCDPSession();
  const sample = async phase => {
    if (sampling) return; sampling = true;
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo'); const ids = processInfo.map(p => p.id).filter(Number.isSafeInteger);
      if (process.platform === 'win32' && ids.length) {
        const command = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`;
        const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
        const values = JSON.parse(stdout), rows = Array.isArray(values) ? values : [values];
        samples.push({ phase, at: Date.now(), workingSetBytes: rows.reduce((n, p) => n + p.WorkingSet64, 0), privateBytes: rows.reduce((n, p) => n + p.PrivateMemorySize64, 0), sumLifetimePeakWorkingSetBytes: rows.reduce((n, p) => n + p.PeakWorkingSet64, 0), processes: rows.length });
      }
    } finally { sampling = false; }
  };
  let phase = 'baseline'; timer = setInterval(() => void sample(phase).catch(() => {}), 1000); await sample(phase); disk.baselineProfileBytes = await diskBytes(profile);
  await page.evaluate(async () => {
    const send = async (type, fields = {}) => { const r = await chrome.runtime.sendMessage({ protocolVersion: 1, type, ...fields }); if (!r?.ok) throw new Error(r?.code); return r; };
    const generation = (await send('ListNotes', { offset: 0 })).library.generation;
    for (let i = 0; i < 150; i++) await send('SaveManualNote', { generation, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId: null, expectedRecordVersion: null,
      fields: { title: `Measured note ${i}`, bodyMarkdown: `Procedure ${i}:\n\n` + 'A local explanation with identifiers, exact code and 中文.\n'.repeat(120), type: 'procedure', tags: ['measurement'], personalExplanation: 'Synthetic resource probe', applicableVersion: 'v1', reviewAfter: null } });
    globalThis.a6send = send;
    globalThis.a6upload = async text => {
      const start = await send('BeginBackupUpload', { bytes: new TextEncoder().encode(text).length });
      for (let i = 0, index = 0; i < text.length; i += 262144, index++) await send('UploadBackupChunk', { transferId: start.backup.transferId, index, text: text.slice(i, i + 262144) });
      return send('PreviewRestore', { transferId: start.backup.transferId });
    };
  });
  disk.originalProfileBytes = await diskBytes(profile); phase = 'export'; let start = performance.now();
  const exported = await page.evaluate(async () => {
    const begin = await globalThis.a6send('ExportBackup'); let text = '';
    for (let i = 0; i < begin.backup.chunks; i++) text += (await globalThis.a6send('ReadBackupChunk', { transferId: begin.backup.transferId, index: i })).backup.text;
    await globalThis.a6send('ReleaseBackupTransfer', { transferId: begin.backup.transferId }); globalThis.a6text = text;
    const b = JSON.parse(text); return { bytes: new TextEncoder().encode(text).length, counts: b.counts, checksums: b.checksums };
  });
  timings.exportMs = performance.now() - start; await sample(phase);
  phase = 'import-and-staging'; start = performance.now();
  const preview = await page.evaluate(async () => (await globalThis.a6upload(globalThis.a6text)).backup.preview);
  timings.importAndStagingMs = performance.now() - start; await sample(phase); disk.dualGenerationProfileBytes = await diskBytes(profile);
  phase = 'activation'; start = performance.now();
  await page.evaluate(operationId => globalThis.a6send('ConfirmRestore', { operationId, mode: 'replace' }), preview.operationId);
  timings.activationAndCleanupMs = performance.now() - start; disk.afterCleanupProfileBytes = await diskBytes(profile); await sample(phase);
  const roundTrip = await page.evaluate(async () => {
    const t = await globalThis.a6send('ExportBackup'); let text = ''; for (let index = 0; index < t.backup.chunks; index++) text += (await globalThis.a6send('ReadBackupChunk', { transferId: t.backup.transferId, index })).backup.text;
    await globalThis.a6send('ReleaseBackupTransfer', { transferId: t.backup.transferId }); return JSON.parse(text).checksums;
  });
  if (JSON.stringify(roundTrip) !== JSON.stringify(exported.checksums)) throw new Error('Round-trip checksums differ');
  phase = '200MiB-boundary'; start = performance.now();
  const boundary = await page.evaluate(async () => {
    // Valid canonical payload plus JSON whitespace exercises actual byte-size,
    // transport and parse admission at the ceiling without claiming a 200 MiB
    // graph/corpus capacity. The active library is never replaced by this probe.
    const limit = 200 * 1024 * 1024, original = globalThis.a6text, bytes = new TextEncoder().encode(original).length;
    const text = original + ' '.repeat(limit - bytes);
    const preview = await globalThis.a6upload(text); await globalThis.a6send('CancelRestore');
    const rejected = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'BeginBackupUpload', bytes: limit + 1 });
    return { acceptedBytes: preview.backup.preview.bytes, overCeilingCode: rejected.code, payload: '150-note canonical graph padded with JSON whitespace to exactly 200 MiB; not a 200 MiB content corpus' };
  });
  timings.boundaryImportAndCancelMs = performance.now() - start; await sample(phase);
  if (requests.length) throw new Error('Unexpected network requests');
  const record = { measuredAt: new Date().toISOString(), browser: context.browser().version(), cpu: cpus()[0]?.model, physicalMemoryBytes: totalmem(), exported, disk, timings, boundary, samples,
    peakSampledWorkingSetBytes: Math.max(0, ...samples.map(s => s.workingSetBytes)), peakSampledPrivateBytes: Math.max(0, ...samples.map(s => s.privateBytes)), sumLifetimePeakWorkingSetUpperEnvelopeBytes: Math.max(0, ...samples.map(s => s.sumLifetimePeakWorkingSetBytes)), externalRequests: requests,
    limits: 'One Windows machine, disposable Chromium, 150 synthetic notes. Sampled whole-browser process memory (including UI/search/startup), not exact allocator peak. Sum of per-process lifetime peaks is a non-simultaneous upper envelope. Disk is whole disposable profile including Chrome overhead, not physical allocated blocks. 200 MiB whitespace boundary is parser/transport evidence only; large complex-graph capacity is unmeasured. No capacity guarantee.' };
  await writeFile('artifacts/a6-resources.json', JSON.stringify(record, null, 2)); console.log(JSON.stringify({ exportedBytes: exported.bytes, timings, disk, peakSampledWorkingSetBytes: record.peakSampledWorkingSetBytes, boundary }));
  await cdp.detach();
} finally {
  clearInterval(timer); await context.close();
  const child = relative(resolve('.cache/profiles'), profile); if (!child.startsWith('a6-resource-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe cleanup');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
