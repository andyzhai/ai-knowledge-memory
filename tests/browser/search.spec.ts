import { test, expect, chromium, type BrowserContext, type Page, type Worker as PlaywrightWorker } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { cpus, totalmem, release } from 'node:os';
import type { SaveManualNote } from '../../src/shared/knowledge';

let context: BrowserContext, library: Page, sw: PlaywrightWorker, profile: string, extensionId: string, generation: string;
async function launch() {
  const path = resolve('.cache/authorized-extension');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`] });
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(sw.url()).host;
  library = await context.newPage(); await library.goto(`chrome-extension://${extensionId}/library.html`);
  await expect(library.locator('[data-search-phase="ready"]')).toBeVisible();
  generation = await library.evaluate(async () => (await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetSearchState' })).marker.generation);
}
test.beforeEach(async () => { await mkdir('.cache/profiles', { recursive: true }); profile = await mkdtemp(resolve('.cache/profiles/a3-')); await launch(); });
test.afterEach(async () => {
  await context?.close();
  const child = relative(resolve('.cache/profiles'), resolve(profile));
  if (!child.startsWith('a3-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe profile cleanup');
  await rm(resolve(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function save(title: string, bodyMarkdown: string, noteId: string | null = null, expectedRecordVersion: number | null = null) {
  const command: SaveManualNote = { protocolVersion: 1, type: 'SaveManualNote', generation, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId, expectedRecordVersion,
    fields: { title, bodyMarkdown, tags: ['operations'], type: 'reference', personalExplanation: '', applicableVersion: 'v2.4.1', reviewAfter: null } };
  const reply = await library.evaluate(command => chrome.runtime.sendMessage(command), command); expect(reply.ok).toBe(true); return reply.result;
}
async function search(query: string, page = library) { await page.getByLabel('Search saved Knowledge').fill(query); await expect(page.locator('[data-search-phase="ready"]')).toBeVisible(); }

test('selection and manual note survive restart, recall offline, open sources and copy exact visible content', async () => {
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-synthetic.html' }));
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await library.getByRole('button', { name: 'Enable ChatGPT' }).click();
  await library.getByRole('link', { name: 'Knowledge', exact: true }).click();
  const provider = await context.newPage(); await provider.goto('https://chatgpt.com/c/synthetic-a0');
  await expect(provider.locator('#akm-a0-probe')).toHaveCount(1);
  await provider.locator('#code-text').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
  const source = await provider.locator('#code-text').textContent();
  await provider.getByRole('button', { name: 'Keep selection', exact: true }).click();
  await expect(provider.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  await save('Manual Unicode 🧠', 'Manual HT-928\n\n```sh\n  pine --dry-run  \n\t# 中文\n```\n');
  await context.close(); await launch(); await context.setOffline(true);
  const requests: string[] = []; context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await library.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as typeof window & { copied?: string }).copied = value; } } }); });
  await search('Manual HT-928'); await expect(library.locator('.results li')).toHaveCount(1);
  await library.getByLabel('Search saved Knowledge').press('ArrowDown'); await expect(library.getByRole('button', { name: 'Recall Manual Unicode 🧠' })).toBeFocused();
  await library.keyboard.press('Enter'); await expect(library.locator('.editor-heading h2')).toHaveText('Manual Unicode 🧠');
  const visible = 'Manual HT-928\n\n```sh\n  pine --dry-run  \n\t# 中文\n```\n';
  await library.getByText('Copy note', { exact: true }).click(); await library.getByRole('button', { name: 'Copy saved Markdown', exact: true }).click();
  expect(await library.evaluate(() => (window as typeof window & { copied?: string }).copied)).toBe(visible);
  await search('retry'); await library.getByText('Filter Knowledge', { exact: true }).click(); await library.getByLabel('Source provider', { exact: true }).selectOption('chatgpt');
  await expect(library.locator('.results li')).toHaveCount(1); await library.locator('.search-open').click();
  await library.locator('summary').filter({ hasText: /^Sources \(/ }).click();
  await expect(library.getByRole('article', { name: 'Local source excerpts' })).toBeVisible(); await expect(library.locator('.source-excerpt pre')).toHaveText(source!);
  expect(requests).toEqual([]);
  await library.setViewportSize({ width: 360, height: 800 }); expect(await library.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await library.screenshot({ path: 'artifacts/a3-recall-360.png', fullPage: true });
});

test('two views update and reconcile removed text; Archive remains a lazy boundary', async () => {
  const first = await save('Changing note', 'staleidentifier alpha');
  const second = await context.newPage(); await second.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await search('staleidentifier'); await search('staleidentifier', second);
  await expect(second.locator('.results li')).toHaveCount(1);
  await save('Changing note', 'freshidentifier beta', first.knowledgeId, 1);
  await expect(library.locator('.results li')).toHaveCount(0); await expect(second.locator('.results li')).toHaveCount(0);
  await search('freshidentifier', second); await expect(second.locator('.results li')).toHaveCount(1);
  await second.getByLabel('Search collection').selectOption('archive'); await expect(second.locator('[data-archive-phase="ready"]')).toBeVisible();
  await expect(second.getByText(/No captured conversations yet/)).toBeVisible();
  await second.getByLabel('Search collection').selectOption('knowledge'); await expect(second.locator('.results li')).toHaveCount(1);
  // Lost notifications are recovered by focus reconciliation, including no-match.
  await library.evaluate(async generation => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open(`akm-library-${generation}`); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction(['meta', 'knowledgeItems'], 'readwrite'); tx.objectStore('knowledgeItems').clear(); const request = tx.objectStore('meta').get('library'); request.onsuccess = () => tx.objectStore('meta').put({ ...request.result, dataSeq: request.result.dataSeq + 1 }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  }, generation);
  await second.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(second.locator('.results li')).toHaveCount(0);
  await second.getByText('Filter Knowledge', { exact: true }).click();
  await second.getByRole('button', { name: 'Rebuild search index' }).click(); await expect(second.locator('[data-search-phase="ready"]')).toBeVisible(); await expect(second.locator('.results li')).toHaveCount(0);
});

test('late query responses cannot replace a newer query or a newer canonical revision', async () => {
  await save('Old query result', 'oldtoken'); await save('New query result', 'newtoken');
  await library.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      slow = new Set<number>();
      override postMessage(message: { type: string; query?: string; queryId: number }) { if (message.type === 'search' && message.query === 'oldtoken') this.slow.add(message.queryId); super.postMessage(message); }
      override set onmessage(handler: ((this: Worker, event: MessageEvent) => unknown) | null) { super.onmessage = event => { if (this.slow.has(event.data.queryId)) setTimeout(() => handler?.call(this, event), 600); else handler?.call(this, event); }; }
    };
  });
  await library.reload(); await expect(library.locator('[data-search-phase="ready"]')).toBeVisible();
  await library.getByLabel('Search saved Knowledge').fill('oldtoken');
  await library.waitForTimeout(100); // Allow the 75ms debounce to submit the deliberately delayed query.
  await library.getByLabel('Search saved Knowledge').fill('newtoken');
  await expect(library.locator('.results h3')).toHaveText('New query result');
  // Wait for the deliberately delayed callback, not for ordinary UI readiness.
  await library.waitForTimeout(800); await expect(library.locator('.results h3')).toHaveText('New query result');
});

test('search reads reject stale pages, malformed envelopes and content-script callers', async () => {
  const state = await library.evaluate(() => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetSearchState' }));
  await save('Increment sequence', 'new note');
  expect(await library.evaluate(marker => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ReadSearchPage', marker, afterId: null }), state.marker)).toMatchObject({ ok: false, code: 'SEARCH_CHANGED' });
  expect(await library.evaluate(marker => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'HydrateSearchResults', marker, ids: new Array(9).fill(crypto.randomUUID()) }), state.marker)).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-synthetic.html' }));
  const provider = await context.newPage(); await provider.goto('https://chatgpt.com/c/synthetic-a0');
  const reply = await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); return (await chrome.scripting.executeScript({ target: { tabId: tab!.id! }, func: () => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetSearchState' }) }))[0]!.result; });
  expect(reply).toMatchObject({ ok: false, code: 'UNAUTHORIZED_CONTEXT' });
});

test('a failed worker startup leaves recent notes available and rebuild recovers', async () => {
  await save('Accessible recent note', 'recoverable worker example');
  await library.addInitScript(() => {
    const NativeWorker = window.Worker; let failOnce = true;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) { if (failOnce) { failOnce = false; throw new Error('Synthetic startup failure'); } super(url, options); }
    };
  });
  await library.reload(); await expect(library.locator('[data-search-phase="error"]')).toBeVisible();
  await expect(library.getByRole('button', { name: 'Accessible recent note', exact: true })).toBeVisible();
  await library.getByText('Filter Knowledge', { exact: true }).click();
  await library.getByRole('button', { name: 'Rebuild search index' }).click(); await search('recoverable');
  await expect(library.locator('.results h3')).toHaveText('Accessible recent note');
});

// Representative fixture writes are test-only: production writes still pass
// through commands. This avoids timing 1,000 individual saves as search cost.
async function seed(count: number) {
  await library.evaluate(async ({ generation, count }) => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open(`akm-library-${generation}`); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'knowledgeItems'], 'readwrite'); const notes = tx.objectStore('knowledgeItems'); notes.clear();
      for (let i = 0; i < count; i++) {
        const body = `Reference ${i}: HT-${i} client.retry.count /etc/pine/config.toml --dry-run. 中文学习方法。\n` + 'Inspect the configuration, explain the reason, and preserve the original source. '.repeat(8);
        notes.put({ id: crypto.randomUUID(), schemaVersion: 1, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z', recordVersion: 1, currentVersion: 1,
          title: `Configuration ${i}`, bodyMarkdown: body, plainText: body, contentHash: String(i).padStart(64, '0'), canonicalVersion: 1, tags: i === count - 1 ? ['needle'] : ['operations'], personalExplanation: 'Why this configuration is useful', applicableVersion: 'v2.4.1', reviewAfter: null,
          type: 'reference', reviewState: i % 13 === 0 ? 'superseded' : i % 7 === 0 ? 'needs_review' : i % 3 === 0 ? 'endorsed' : 'saved', reviewedAt: null, supersededById: null, origin: 'manual_note', sourceKind: 'manual', curationKey: null, createdByRequestId: crypto.randomUUID() });
      }
      const request = tx.objectStore('meta').get('library'); request.onsuccess = () => tx.objectStore('meta').put({ ...request.result, dataSeq: request.result.dataSeq + 1 });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); db.close();
  }, { generation, count });
}
async function workerHeapUsage() {
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const heaps = [];
    for (const target of targetInfos.filter(target => target.type === 'worker' && target.url.endsWith('/search-worker.js'))) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await new Promise<unknown>((resolve, reject) => {
        const receive = (event: { sessionId: string; message: string }) => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message); if (message.id !== 1) return;
          clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive); resolve(message.result ?? message.error);
        };
        cdp.on('Target.receivedMessageFromTarget', receive);
        timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', receive); reject(new Error('Worker heap measurement timed out')); }, 5000);
        void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' }) }).catch(reject);
      });
      clearTimeout(timer); heaps.push(result); await cdp.send('Target.detachFromTarget', { sessionId });
    }
    return heaps;
  } finally { await cdp.detach(); }
}
test('measures small and larger corpora with two views and finds filtered hits beyond top 50', async () => {
  test.setTimeout(120_000);
  const measurements: unknown[] = [];
  for (const count of [30, 1000]) {
    await seed(count);
    const start = performance.now(); await library.reload(); await expect(library.locator('[data-search-phase="ready"]')).toBeVisible({ timeout: 30_000 }); const coldMs = performance.now() - start;
    await search('config'); const warmMs = Number(await library.locator('[data-search-phase]').getAttribute('data-search-ms'));
    const cdp = await context.newCDPSession(library); const heapOne = await cdp.send('Runtime.getHeapUsage');
    const second = await context.newPage(); const secondStart = performance.now(); await second.goto(`chrome-extension://${extensionId}/sidepanel.html`); await expect(second.locator('[data-search-phase="ready"]')).toBeVisible({ timeout: 30_000 });
    const cdpTwo = await context.newCDPSession(second); const heapTwo = await cdpTwo.send('Runtime.getHeapUsage');
    const secondViewMs = performance.now() - secondStart;
    const workerHeaps = await workerHeapUsage(); expect(workerHeaps).toHaveLength(2);
    measurements.push({ count, coldMs, warmMs, secondViewMs, oneViewHeap: heapOne, secondViewHeap: heapTwo, workerHeaps, browser: context.browser()?.version(), platform: process.platform, osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, physicalMemoryBytes: totalmem() });
    await library.getByText('Filter Knowledge', { exact: true }).click(); await library.getByLabel('Exact tag').fill('needle');
    await expect(library.locator('.results li')).toHaveCount(1); await expect(library.locator('.results h3')).toHaveText(`Configuration ${count - 1}`);
    await second.close(); await cdp.detach();
  }
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/a3-performance.json', JSON.stringify(measurements, null, 2));
});
