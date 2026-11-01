import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { cpus, totalmem, release } from 'node:os';
import { createHash } from 'node:crypto';
import corpus from '../fixtures/evaluation-corpus.json' with { type: 'json' };
import model from '../../src/search/model-manifest.json' with { type: 'json' };
import { EMBEDDING_SIGNATURE, type SemanticReply, type SemanticRequest } from '../../src/shared/semantic';
import { SEARCH_POLICY_VERSION, type SearchDocument, type SearchResult, type SearchWorkerReply, type SearchWorkerRequest } from '../../src/shared/search';
import { fuseResults } from '../../src/search/semantic';

let context: BrowserContext, page: Page, profile: string, extensionId: string;
type Metrics = { top5: string[]; firstRanked: string | null; correctInTop5: boolean; reciprocalRank: number | null; missing: string[]; nonLabelSuggestions: string[]; noMatchSuggestionCount: number | null };
type Row = typeof corpus.queries[number] & { lexical: Metrics; semantic: Metrics; hybrid: Metrics; lexicalMs: number; semanticMs: number | null; exactOrderProtected: boolean; userSelectedResult: null; observedUserTimeToUsefulContentMs: null };
const marker = { generation: 'h-evaluation', dataSeq: 1, policyVersion: SEARCH_POLICY_VERSION };
const documents: SearchDocument[] = corpus.notes.map(note => ({ providers: ['manual'], note: {
  id: note.id, title: note.title, bodyMarkdown: note.body, plainText: note.body, tags: note.tags,
  schemaVersion: 1, recordVersion: 1, currentVersion: 1, canonicalVersion: 1, contentHash: createHash('sha256').update(note.body).digest('hex'), type: 'reference',
  createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z', personalExplanation: '', applicableVersion: '', reviewAfter: null,
  reviewState: 'saved', reviewedAt: null, supersededById: null, origin: 'manual_note', sourceKind: 'manual', curationKey: null, createdByRequestId: note.id,
} }));
test.beforeEach(async () => {
  await mkdir('.cache/profiles', { recursive: true }); profile = await mkdtemp(resolve('.cache/profiles/h-test-'));
  const extension = resolve('dist-h');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--disable-gpu', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(sw.url()).host;
  page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/library.html`);
  await expect(page.locator('[data-search-phase="ready"]')).toBeVisible();
});
test.afterEach(async () => {
  await context?.close();
  const child = relative(resolve('.cache/profiles'), resolve(profile));
  if (!child.startsWith('h-test-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe profile cleanup');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function startProbe(target: Page) {
  await target.evaluate(() => {
    const host = window as typeof window & { probes: Record<string, Worker> };
    host.probes = { lexical: new Worker(chrome.runtime.getURL('search-worker.js'), { type: 'module' }), semantic: new Worker(chrome.runtime.getURL('semantic-worker.js'), { type: 'module' }) };
  });
}
async function rpc(target: Page, mode: string, request: SemanticRequest | SearchWorkerRequest): Promise<SemanticReply | SearchWorkerReply> {
  return target.evaluate(({ mode, request }) => new Promise((resolve, reject) => {
    const worker = (window as typeof window & { probes: Record<string, Worker> }).probes[mode]!;
    const timer = setTimeout(() => reject(new Error('Probe timed out')), 90_000);
    worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
    worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
    worker.postMessage(request);
  }), { mode, request });
}
async function workerHeaps() {
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets'); const heaps: unknown[] = [];
    for (const target of targetInfos.filter(target => target.type === 'worker' && target.url.endsWith('/semantic-worker.js'))) {
      const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }).catch(error => {
        if (String(error).includes('No target with given id')) return null;
        throw error;
      });
      if (!attached) continue; // The closing-view check can race worker destruction.
      const { sessionId } = attached;
      const heap = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Heap timed out')), 5000);
        const receive = (event: { sessionId: string; message: string }) => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message); if (message.id !== 1) return;
          clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive); resolve(message.result ?? message.error);
        };
        cdp.on('Target.receivedMessageFromTarget', receive);
        void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' }) }).catch(reject);
      });
      heaps.push(heap); await cdp.send('Target.detachFromTarget', { sessionId });
    }
    return heaps;
  } finally { await cdp.detach(); }
}
async function save(title: string, body: string, noteId: string | null = null, expectedRecordVersion: number | null = null) {
  return page.evaluate(async ({ title, body, noteId, expectedRecordVersion }) => {
    const state = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetSearchState' });
    const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'SaveManualNote', generation: state.marker.generation,
      requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId, expectedRecordVersion,
      fields: { title, bodyMarkdown: body, type: 'reference', tags: [], personalExplanation: '', applicableVersion: '', reviewAfter: null } });
    if (!reply.ok) throw new Error(reply.code); return reply.result;
  }, { title, body, noteId, expectedRecordVersion });
}

test('compares fixed development/holdout queries in packaged CPU workers offline and measures two views', async () => {
  const network: string[] = []; context.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await context.setOffline(true); await startProbe(page);
  const start = performance.now();
  const lexicalReady = await rpc(page, 'lexical', { type: 'build', buildId: 1, marker, documents });
  const lexicalBuildMs = performance.now() - start; expect(lexicalReady.type).toBe('ready');
  const semanticStart = performance.now();
  const ready = await rpc(page, 'semantic', { type: 'build', buildId: 1, marker, documents, signature: EMBEDDING_SIGNATURE });
  expect(ready.type).toBe('ready'); const coldModelAndIndexMs = performance.now() - semanticStart;
  const oneViewHeaps = await workerHeaps(); expect(oneViewHeaps).toHaveLength(1);
  const rows: Row[] = [];
  for (const [i, label] of corpus.queries.entries()) {
    const start = performance.now();
    const lexical = await rpc(page, 'lexical', { type: 'search', queryId: i + 1, marker, query: label.query, options: {} });
    const lexicalMs = performance.now() - start;
    const semantic = await rpc(page, 'semantic', { type: 'search', queryId: i + 1, marker, signature: EMBEDDING_SIGNATURE, query: label.query, options: {} });
    if (lexical.type !== 'results' || semantic.type !== 'results') throw new Error('Expected worker results');
    const hybrid = fuseResults(lexical.result, semantic.result);
    const metrics = (result: SearchResult) => {
      const top5 = result.hits.slice(0, 5).map(hit => hit.id), rank = top5.findIndex(id => label.expected.includes(id));
      return { top5, firstRanked: top5[0] ?? null, correctInTop5: label.expected.length ? rank >= 0 : result.total === 0,
        reciprocalRank: label.expected.length ? rank < 0 ? 0 : 1 / (rank + 1) : null,
        missing: label.expected.filter(id => !top5.includes(id)), nonLabelSuggestions: top5.filter(id => !label.expected.includes(id)),
        // Labels are not exhaustive relevance judgements; do not call every extra candidate a proven false positive.
        noMatchSuggestionCount: label.expected.length ? null : result.total };
    };
    const exact = lexical.result.hits.filter(hit => hit.matchClass === 'exact').map(hit => hit.id);
    expect(hybrid.hits.slice(0, exact.length).map(hit => hit.id)).toEqual(exact);
    rows.push({ ...label, lexical: metrics(lexical.result), semantic: metrics(semantic.result), hybrid: metrics(hybrid),
      lexicalMs, semanticMs: 'elapsedMs' in semantic ? semantic.elapsedMs : null, exactOrderProtected: true, userSelectedResult: null, observedUserTimeToUsefulContentMs: null });
  }
  const second = await context.newPage(); await second.goto(`chrome-extension://${extensionId}/library.html`); await startProbe(second);
  const secondStart = performance.now();
  const secondReady = await rpc(second, 'semantic', { type: 'build', buildId: 1, marker, documents, signature: EMBEDDING_SIGNATURE });
  expect(secondReady.type).toBe('ready'); const secondViewModelAndIndexMs = performance.now() - secondStart;
  const twoViewHeaps = await workerHeaps(); expect(twoViewHeaps).toHaveLength(2);
  await second.close(); await expect.poll(async () => (await workerHeaps()).length).toBe(1);
  // A fresh owner loads packaged assets offline with no persisted vectors/cache.
  await page.reload(); await startProbe(page);
  const reopenStart = performance.now(); const reopened = await rpc(page, 'semantic', { type: 'build', buildId: 1, marker, documents, signature: EMBEDDING_SIGNATURE });
  expect(reopened.type).toBe('ready');
  let packageBytes = 0;
  async function size(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) { const child = `${path}/${entry.name}`; if (entry.isDirectory()) await size(child); else packageBytes += (await stat(child)).size; } }
  await size('dist-h');
  const output = { corpusVersion: corpus.version, corpusSha256: createHash('sha256').update(await readFile('tests/fixtures/evaluation-corpus.json')).digest('hex'), model,
    signature: EMBEDDING_SIGNATURE, policy: 'RRF k=60 as a fixed baseline; exact lexical prefix protected; semantic suggestions unthresholded and explicitly labeled. No holdout tuning.',
    rows, summary: Object.fromEntries(['development', 'holdout'].map(split => [split, Object.fromEntries(['lexical', 'semantic', 'hybrid'].map(mode => [mode, {
      count: rows.filter(row => row.split === split).length, correctInTop5: rows.filter(row => row.split === split && row[mode as 'lexical'].correctInTop5).length,
    }]))])), measurements: { lexicalBuildMs, coldModelAndIndexMs, secondViewModelAndIndexMs, offlineReopenMs: performance.now() - reopenStart,
      oneViewHeaps, twoViewHeaps, packageBytes, modelBytes: model.files.reduce((sum, file) => sum + file.bytes, 0), ready,
      browser: context.browser()?.version(), platform: process.platform, osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, physicalMemoryBytes: totalmem(),
      gpu: 'disabled by test launch; device=wasm, numThreads=1; GPU acceleration not implemented', externalRequests: network },
    limitations: 'Synthetic labeled retrieval only. No human selected-result or time-to-useful-content observations; heap samples are not peak process RSS. No numeric quality threshold tuned.' };
  expect(network).toEqual([]); await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/h-evaluation.json', JSON.stringify(output, null, 2));
});

test('opt-in, delayed model/inference, disable, close and canonical edits leave lexical recall usable', async () => {
  const saved = await save('Learning', 'Explain an idea to another person to find gaps in understanding.');
  await save('Exact retry', 'HT-928 client.retry.count');
  expect(await workerHeaps()).toHaveLength(0);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      semantic: boolean;
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); this.semantic = String(url).endsWith('semantic-worker.js'); }
      override postMessage(message: unknown) { if (this.semantic) setTimeout(() => super.postMessage(message), 1200); else super.postMessage(message); }
    };
  });
  await page.reload();
  await page.getByText('Filter Knowledge', { exact: true }).click();
  const toggle = page.getByLabel('Enable local meaning experiment for this view'); await toggle.check();
  await page.getByLabel('Search saved Knowledge').fill('HT-928');
  await expect(page.locator('.results h3')).toHaveText('Exact retry');
  await expect(page.locator('[data-meaning-phase]')).toHaveAttribute('data-meaning-phase', 'loading');
  await toggle.uncheck(); await expect.poll(async () => (await workerHeaps()).length).toBe(0);
  await toggle.check(); await expect(page.locator('[data-meaning-phase="ready"]')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Search saved Knowledge').fill('learning by teaching');
  await expect(page.getByRole('region', { name: 'Related by meaning' }).getByRole('button', { name: 'Learning' })).toBeVisible();
  await save('Edited note', 'Completely replaced with a recipe for bread.', saved.knowledgeId, 1);
  await expect(page.locator('[data-meaning-phase="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Related by meaning' }).getByRole('button', { name: 'Learning', exact: true })).toHaveCount(0);
  const portable = await page.evaluate(async () => {
    const transfer = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ExportBackup' }); if (!transfer.ok) throw new Error(transfer.code);
    let text = ''; for (let index = 0; index < transfer.backup.chunks; index++) {
      const part = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ReadBackupChunk', transferId: transfer.backup.transferId, index }); if (!part.ok) throw new Error(part.code); text += part.backup.text;
    }
    await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ReleaseBackupTransfer', transferId: transfer.backup.transferId }); return text;
  });
  // A5's actual reset clears both lexical and semantic workers before deleting
  // canonical rows. The gate must not let late inference restore a snippet.
  await page.evaluate(async () => {
    const state = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetSearchState' });
    const preview = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'PreviewDeletion', generation: state.marker.generation, target: { kind: 'all' } });
    const result = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'DeleteLibraryData', generation: state.marker.generation, target: { kind: 'all' }, expectedDataSeq: preview.preview.dataSeq, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString() });
    if (!result.ok) throw new Error(result.code);
  });
  await expect(page.locator('[data-search-phase="ready"]')).toBeVisible();
  await expect.poll(async () => (await workerHeaps()).length).toBe(0);
  await expect(page.getByRole('region', { name: 'Related by meaning' })).toHaveCount(0);
  await expect(page.getByLabel('Enable local meaning experiment for this view')).not.toBeChecked();
  // Real A6 staging/activation preserves the opt-in boundary and cannot revive
  // an old inference worker or its late suggestions in the restored generation.
  await page.evaluate(async text => {
    const send = async (type: string, fields: Record<string, unknown> = {}) => { const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type, ...fields }); if (!reply.ok) throw new Error(reply.code); return reply; };
    const upload = await send('BeginBackupUpload', { bytes: new TextEncoder().encode(text).length });
    for (let start = 0, index = 0; start < text.length; start += 262144, index++) await send('UploadBackupChunk', { transferId: upload.backup.transferId, index, text: text.slice(start, start + 262144) });
    const preview = await send('PreviewRestore', { transferId: upload.backup.transferId }); await send('ConfirmRestore', { operationId: preview.backup.preview.operationId, mode: 'empty' });
  }, portable);
  await expect(page.locator('[data-search-phase="ready"]')).toBeVisible();
  await expect(page.getByLabel('Enable local meaning experiment for this view')).not.toBeChecked();
  await expect.poll(async () => (await workerHeaps()).length).toBe(0);
  await page.getByLabel('Search saved Knowledge').fill('bread'); await expect(page.locator('.results h3')).toHaveText('Edited note');
  await page.getByRole('link', { name: 'Archive', exact: true }).click();
  await expect(page.locator('[data-archive-phase="ready"]')).toBeVisible();
  await expect.poll(async () => (await workerHeaps()).length).toBe(0);
  await expect(page.getByLabel('Enable local meaning experiment for this view')).toBeHidden();
  await page.close(); await expect.poll(async () => (await workerHeaps()).length).toBe(0);
});

test('corrupt and interrupted packaged assets fail closed while lexical results stay complete', async () => {
  await save('Exact retry', 'HT-928 client.retry.count');
  await page.getByText('Filter Knowledge', { exact: true }).click();
  const path = `dist-h/models/${model.id}/config.json`, original = await readFile(path);
  try {
    for (const bytes of [Buffer.from('incomplete'), Buffer.alloc(original.length, 32)]) {
      await writeFile(path, bytes);
      await page.getByLabel('Enable local meaning experiment for this view').check();
      await page.getByLabel('Search saved Knowledge').fill('HT-928');
      await expect(page.locator('.results h3')).toHaveText('Exact retry');
      await expect(page.locator('[data-meaning-phase="error"]')).toBeVisible();
      await page.getByLabel('Search saved Knowledge').fill('client.retry.count');
      await expect(page.locator('.results h3')).toHaveText('Exact retry');
      await expect(page.locator('[data-meaning-phase="error"]')).toBeVisible();
      await expect.poll(async () => (await workerHeaps()).length).toBe(0);
      await page.getByLabel('Enable local meaning experiment for this view').uncheck();
    }
  } finally { await writeFile(path, original); }
});

test('an unavailable worker constructor cannot break lexical search or page controls', async () => {
  await save('Exact retry', 'HT-928');
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (String(url).endsWith('semantic-worker.js')) throw new Error('Simulated incompatible worker environment');
        super(url, options);
      }
    };
  });
  await page.reload(); await page.getByText('Filter Knowledge', { exact: true }).click();
  await page.getByLabel('Enable local meaning experiment for this view').check();
  await expect(page.locator('[data-meaning-phase="error"]')).toBeVisible();
  await page.getByLabel('Search saved Knowledge').fill('HT-928'); await expect(page.locator('.results h3')).toHaveText('Exact retry');
  await page.getByLabel('Enable local meaning experiment for this view').uncheck();
  await expect(page.locator('[data-meaning-phase="disabled"]')).toBeVisible();
});
