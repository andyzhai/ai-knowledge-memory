import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import type { KnowledgeItem, KnowledgeRevision, LibraryMeta, RequestReceipt } from '../../src/shared/knowledge';
import type { Capture, Message, MessageRevision, SourceRef } from '../../src/shared/archive';

let context: BrowserContext, library: Page, page: Page, sw: Worker, profile: string, extensionId: string;
const url = 'https://chatgpt.com/c/synthetic-a0';
type State = { knowledgeItems: KnowledgeItem[]; knowledgeRevisions: KnowledgeRevision[]; meta: LibraryMeta[]; requestReceipts: RequestReceipt[];
  captures: Capture[]; messages: Message[]; messageRevisions: MessageRevision[]; sourceRefs: SourceRef[]; conversations: unknown[]; connections: unknown[] };
test.beforeEach(async () => {
  await mkdir('.cache/profiles', { recursive: true }); profile = await mkdtemp(resolve('.cache/profiles/a2-'));
  const path = resolve('.cache/authorized-extension');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`] });
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(sw.url()).host;
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-synthetic.html' }));
  library = await context.newPage(); await library.goto(`chrome-extension://${extensionId}/library.html`);
  await expect(library.getByText('Local library ready.', { exact: true })).toBeVisible();
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await library.getByRole('button', { name: 'Enable ChatGPT' }).click();
  await expect(library.getByText('ChatGPT: Enabled')).toBeVisible();
  await library.getByRole('link', { name: 'Knowledge', exact: true }).click();
  page = await context.newPage(); await page.goto(url); await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
});
test.afterEach(async () => {
  await context?.close();
  const child = relative(resolve('.cache/profiles'), resolve(profile));
  if (!child.startsWith('a2-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe profile cleanup');
  await rm(resolve(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function state(): Promise<State> {
  return library.evaluate(async () => {
    const { activeLibrary } = await chrome.storage.local.get('activeLibrary') as { activeLibrary: { generation: string } };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(`akm-library-${activeLibrary.generation}`); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    try {
      const names = Array.from(db.objectStoreNames); const tx = db.transaction(names, 'readonly');
      return Object.fromEntries(await Promise.all(names.map(name => new Promise<[string, unknown[]]>((resolve, reject) => { const req = tx.objectStore(name).getAll(); req.onsuccess = () => resolve([name, req.result]); req.onerror = () => reject(req.error); })))) as State;
    } finally { db.close(); }
  });
}
async function select(id = 'code-text', start = 0, endId = id, end?: number) {
  await page.evaluate(({ id, start, endId, end }) => {
    const first = document.getElementById(id)!.firstChild!, last = document.getElementById(endId)!.firstChild!;
    const range = document.createRange(); range.setStart(first, start); range.setEnd(last, end ?? last.textContent!.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  }, { id, start, endId, end });
}
async function closeFeedback() { await page.getByRole('button', { name: 'Close preview' }).click(); }
async function keep() {
  await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
  await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
}
async function menu(source: 'context-menu' | 'keyboard') {
  await sw.evaluate(async source => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    return chrome.tabs.sendMessage(tab!.id!, { type: 'KeepSelection', source }, { frameId: 0 });
  }, source);
}
async function captureCommand(dropAck = false) {
  await sw.evaluate(async dropAck => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    await chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] }, args: [dropAck], func: dropAck => {
      const runtime = chrome.runtime as unknown as { sendMessage(value: unknown): Promise<unknown> };
      const send = runtime.sendMessage.bind(runtime); let once = dropAck;
      runtime.sendMessage = async command => {
        if ((command as { type?: string }).type === 'CurateSelection') (globalThis as typeof globalThis & { a2Command?: unknown }).a2Command = command;
        const result = await send(command);
        if ((command as { type?: string }).type === 'CurateSelection' && once) { once = false; throw new Error('synthetic lost acknowledgement'); }
        return result;
      };
    } });
  }, dropAck);
}

test('floating keep saves exact code excerpts only, with local source available after the provider closes', async () => {
  await select(); const selected = await page.evaluate(() => getSelection()!.toString()); const raw = await page.locator('#code-text').textContent();
  await keep(); const data = await state();
  expect(data.knowledgeItems).toHaveLength(1); expect(data.knowledgeItems[0]).toMatchObject({ bodyMarkdown: selected, reviewState: 'saved', origin: 'manual_selection' });
  expect(data.sourceRefs).toHaveLength(1); expect(data.sourceRefs[0]).toMatchObject({ exactText: raw, contentScope: 'excerpt', blockKind: 'code', sourceProvider: 'chatgpt', sourceUrl: url, fragmentOrder: 0 });
  expect(data.messageRevisions[0]).toMatchObject({ plainText: raw, contentScope: 'excerpt', blocks: [{ kind: 'code', text: raw, language: null }] });
  expect(data.messages[0]).toMatchObject({ sourceMessageId: null, originMessageLocator: 'a1', contentScope: 'excerpt' });
  expect(data.sourceRefs[0]!.anchor).toMatchObject({ start: 0, end: Array.from(raw!).length, quote: raw });
  expect(JSON.stringify(data)).not.toContain('Start 🧠'); expect(JSON.stringify(data)).not.toContain('Private unsent prompt');
  expect(data.captures[0]).toMatchObject({ scope: 'selection', captureStatus: 'completed', independentlyRetained: false });
  const opening = context.waitForEvent('page'); await page.getByRole('button', { name: 'Open local source' }).click(); const detail = await opening;
  await page.close(); await detail.locator('summary').filter({ hasText: /^Sources \(/ }).click();
  await expect(detail.getByRole('article', { name: 'Local source excerpts' })).toBeVisible();
  await expect(detail.locator('.source-excerpt pre')).toHaveText(raw!);
  expect(await detail.getByRole('link', { name: 'Open original conversation' }).getAttribute('href')).toBe(url);
  await detail.setViewportSize({ width: 360, height: 800 });
  expect(await detail.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await detail.screenshot({ path: 'artifacts/a2-source-detail-360.png', fullPage: true });
});

test('context menu freezes before focus collapse and keyboard command saves the current selection', async () => {
  await select('answer-text', 9, 'answer-text', 11);
  await page.locator('#answer-text').click({ button: 'right', position: { x: 75, y: 5 } });
  await page.evaluate(() => getSelection()!.removeAllRanges()); await menu('context-menu');
  await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  expect((await state()).sourceRefs[0]!.exactText).toBe('中文');
  await closeFeedback(); await select('repeat-one'); await menu('keyboard');
  await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  expect((await state()).knowledgeItems).toHaveLength(2);
});

test('cross-message fragments retain ordered roles, code-point anchors and exact partial code', async () => {
  await select('user-text', 8, 'answer-text', 11); await keep();
  let data = await state(); const sources = [...data.sourceRefs].sort((a, b) => a.fragmentOrder! - b.fragmentOrder!);
  expect(sources.map(row => row.sourceRole)).toEqual(['user', 'assistant']); expect(sources.map(row => row.exactText)).toEqual(['HT-928 🧠 中文.', 'Start 🧠 中文']);
  for (const source of sources) expect(source.anchor!.end).toBe(Array.from(source.exactText).length);
  await closeFeedback(); await select('code-text', 10, 'code-text', 25); const exact = await page.evaluate(() => getSelection()!.toString()); await keep();
  data = await state(); expect(data.sourceRefs.find(row => row.exactText === exact)?.blockKind).toBe('code');
});

test('repeated known occurrence is Already saved; distinct repeated quotes and unknown identity are separate', async () => {
  await select('repeat-one'); await keep(); const first = (await state()).knowledgeItems[0]!;
  await closeFeedback(); await select('repeat-one'); await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
  await expect(page.getByText('Already saved. Your existing note was kept unchanged.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo new selection' })).toHaveCount(0);
  expect((await state()).knowledgeItems[0]!.id).toBe(first.id); expect((await state()).meta[0]!.dataSeq).toBe(1);
  await closeFeedback(); await select('repeat-two'); await keep(); expect((await state()).knowledgeItems).toHaveLength(2);
  await closeFeedback(); await page.locator('[data-message-id="a1"]').evaluate(node => node.removeAttribute('data-message-id'));
  await select('repeat-one'); await keep(); await closeFeedback(); await select('repeat-one'); await keep();
  const data = await state(); expect(data.knowledgeItems).toHaveLength(4);
  expect(data.sourceRefs.filter(row => row.originalPageAnchor === null)).toHaveLength(2);
});

test('lost acknowledgement retries the exact intent and mismatched request reuse fails', async () => {
  await captureCommand(true); await select(); await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
  await expect(page.getByText(/Selection save unavailable: WRITE_UNCONFIRMED/)).toBeVisible();
  await page.getByRole('button', { name: 'Retry same selection' }).click(); await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  const result = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const result = await chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] }, func: async () => {
      const command = structuredClone((globalThis as typeof globalThis & { a2Command: import('../../src/shared/curation').CurateSelection }).a2Command);
      command.snapshot.selectedText += '!'; return chrome.runtime.sendMessage(command);
    } }); return result[0]!.result;
  });
  expect(result).toMatchObject({ ok: false, code: 'REQUEST_ID_REUSED' });
  const data = await state(); expect(data.knowledgeItems).toHaveLength(1); expect(data.captures).toHaveLength(1); expect(data.meta[0]!.dataSeq).toBe(1);
});

test('endorsement is explicit, adds history, and prevents destructive immediate undo', async () => {
  await select(); await keep(); await page.getByRole('button', { name: 'Endorse', exact: true }).click();
  await expect(page.getByText('Endorsed. Your approval is recorded in saved history.')).toBeVisible();
  const data = await state(); expect(data.knowledgeItems[0]).toMatchObject({ reviewState: 'endorsed', recordVersion: 2 });
  expect(data.knowledgeItems[0]!.reviewedAt).not.toBeNull(); expect(data.knowledgeRevisions).toHaveLength(2);
  const note = data.knowledgeItems[0]!;
  expect(await library.evaluate(command => chrome.runtime.sendMessage(command), { protocolVersion: 1, type: 'UndoSelection', generation: data.meta[0]!.generation, savedRequestId: note.createdByRequestId,
    requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), expectedRecordVersion: 2 })).toMatchObject({ ok: false, code: 'UNDO_CHANGED' });
  await closeFeedback(); await select(); await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
  await expect(page.getByText('Already saved. Your existing note was kept unchanged.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Endorse', exact: true })).toHaveCount(0);
  expect((await state()).knowledgeItems[0]).toEqual(note);
  await library.getByRole('button', { name: 'Refresh library' }).click(); await library.getByRole('button', { name: 'ChatGPT selection', exact: true }).click();
  await expect(library.getByRole('button', { name: 'Endorse note', exact: true })).toBeDisabled();
});

test('immediate undo removes only owned excerpts, invalidates receipts, and is idempotent', async () => {
  await select(); await keep(); const before = await state(); const note = before.knowledgeItems[0]!;
  const undo = { protocolVersion: 1, type: 'UndoSelection', generation: before.meta[0]!.generation, savedRequestId: note.createdByRequestId,
    requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), expectedRecordVersion: 1 };
  expect(await library.evaluate(command => chrome.runtime.sendMessage(command), undo)).toMatchObject({ ok: true, result: { removed: true } });
  expect(await library.evaluate(command => chrome.runtime.sendMessage(command), undo)).toMatchObject({ ok: true, result: { removed: true, deduplicated: true } });
  const data = await state(); for (const key of ['knowledgeItems', 'knowledgeRevisions', 'sourceRefs', 'captures', 'messages', 'messageRevisions', 'conversations'] as const) expect(data[key]).toHaveLength(0);
  expect(data.requestReceipts.find(row => row.requestId === note.createdByRequestId)!.invalidated).toBe(true); expect(data.meta[0]!.dataSeq).toBe(2);
  await closeFeedback(); await select(); await keep(); expect((await state()).knowledgeItems).toHaveLength(1);
});

for (const retention of ['capture', 'message', 'shared-source'] as const) {
  test(`undo preserves ${retention} retention and reports remaining source data`, async () => {
    await select(); await keep();
    await library.evaluate(async retention => {
      const { activeLibrary } = await chrome.storage.local.get('activeLibrary') as { activeLibrary: { generation: string } };
      const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open(`akm-library-${activeLibrary.generation}`); req.onsuccess = () => resolve(req.result); });
      try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['captures', 'messages', 'sourceRefs'], 'readwrite'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        const store = tx.objectStore(retention === 'capture' ? 'captures' : retention === 'message' ? 'messages' : 'sourceRefs');
        const req = store.getAll(); req.onsuccess = () => {
          const first = req.result[0]; store.put(retention === 'shared-source' ? { ...first, id: crypto.randomUUID(), knowledgeId: 'another-retained-note' } : { ...first, independentlyRetained: true });
        };
      }); } finally { db.close(); }
    }, retention);
    await page.getByRole('button', { name: 'Undo new selection' }).click();
    await expect(page.getByText('Undone. Shared or independently retained sources remain in the library.')).toBeVisible();
    const data = await state(); expect(data.knowledgeItems).toHaveLength(0); expect(data.captures).toHaveLength(1); expect(data.messageRevisions).toHaveLength(1);
  });
}

test('recognized temporary mode requires a trusted allowance and allowance expires on navigation', async () => {
  await page.evaluate(() => { const banner = document.createElement('div'); banner.dataset.testid = 'temporary-chat-banner'; banner.textContent = 'Temporary chat'; document.body.prepend(banner); });
  await select(); await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
  await expect(page.getByText(/TEMPORARY_ALLOW_REQUIRED/)).toBeVisible(); expect((await state()).knowledgeItems).toHaveLength(0);
  await page.getByRole('button', { name: 'Allow saving this conversation' }).click();
  await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  expect((await state()).sourceRefs[0]!.temporaryStatus).toBe('temporary');
  await page.evaluate(() => { history.pushState({}, '', '/c/other'); history.pushState({}, '', '/c/synthetic-a0'); });
  await select('answer-text'); await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
  await expect(page.getByText(/TEMPORARY_ALLOW_REQUIRED/)).toBeVisible(); expect((await state()).knowledgeItems).toHaveLength(1);
});

async function holdHashes() {
  await sw.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...args: Parameters<SubtleCrypto['digest']>) => new Promise(resolve => {
      const global = globalThis as typeof globalThis & { a2HashPending?: boolean; a2Release?: (() => void)[] };
      global.a2HashPending = true; (global.a2Release ??= []).push(() => { void digest(...args).then(resolve); });
    });
  });
}
async function releaseHashes() { await sw.evaluate(() => { for (const release of (globalThis as typeof globalThis & { a2Release: (() => void)[] }).a2Release) release(); }); }

for (const race of ['navigation', 'document', 'disable'] as const) {
  test(`${race} during hash preparation cannot commit a stale selection`, async () => {
    await holdHashes(); await select(); await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
    await expect.poll(() => sw.evaluate(() => (globalThis as typeof globalThis & { a2HashPending?: boolean }).a2HashPending)).toBe(true);
    if (race === 'navigation') await page.evaluate(() => { history.pushState({}, '', '/c/other'); history.pushState({}, '', '/c/synthetic-a0'); });
    if (race === 'document') await page.reload();
    if (race === 'disable') await library.evaluate(() => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'SetProviderEnabled', enabled: false }));
    await releaseHashes();
    if (race !== 'document') await expect(page.getByText(/Selection save unavailable: (NAVIGATION_CHANGED|PERMISSION_DENIED|PROVIDER_STATE_CHANGED)/)).toBeVisible();
    // Queue a UI command after the save path's admission settles.
    await library.evaluate(() => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetStatus' }));
    expect((await state()).knowledgeItems).toHaveLength(0);
  });
}

test('storage failure leaves the exact selection for retry and aborts the complete source graph', async () => {
  await sw.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
      if (this.name === 'sourceRefs') throw new DOMException('synthetic quota', 'QuotaExceededError'); return add.apply(this, args);
    };
    (globalThis as typeof globalThis & { a2Restore?: () => void }).a2Restore = () => { IDBObjectStore.prototype.add = add; };
  });
  await select(); const exact = await page.evaluate(() => getSelection()!.toString()); await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
  await expect(page.getByText(/Selection save unavailable: STORAGE_FULL/)).toBeVisible(); await expect(page.locator('#akm-a0-probe pre')).toHaveText(exact);
  const data = await state(); for (const key of ['knowledgeItems', 'sourceRefs', 'captures', 'messages', 'messageRevisions', 'conversations', 'connections', 'requestReceipts'] as const) expect(data[key]).toHaveLength(0);
  await sw.evaluate(() => (globalThis as typeof globalThis & { a2Restore: () => void }).a2Restore());
  await page.getByRole('button', { name: 'Retry same selection' }).click(); await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
});

test('modern observed DOM saves; editable ancestors and spoofed page events cannot save', async () => {
  await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-current-structure.html' })); await page.reload();
  await select('answer-text'); await keep(); await closeFeedback();
  await page.locator('[data-chatgpt-selection-message-id]').first().evaluate(node => node.setAttribute('contenteditable', 'true'));
  await select('answer-text'); await menu('keyboard'); await expect(page.getByText(/Selection save unavailable: EXCLUDED_CONTENT/)).toBeVisible();
  await page.evaluate(() => { window.postMessage({ type: 'KeepSelection', source: 'keyboard' }, '*'); document.querySelector('#akm-a0-probe')!.shadowRoot!.querySelector('button')!.click(); });
  expect((await state()).knowledgeItems).toHaveLength(1);
});

for (const phase of ['before-commit', 'after-commit'] as const) {
  test(`worker termination ${phase} preserves the selection intent and converges to one complete graph`, async () => {
    test.setTimeout(60000);
    const cdp = await context.newCDPSession(library); let versionId = '';
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      const current = versions.find((version: { scriptURL: string; runningStatus: string }) => version.scriptURL === sw.url() && version.runningStatus === 'running');
      if (current) versionId = current.versionId;
    });
    await cdp.send('ServiceWorker.enable'); await expect.poll(() => versionId).not.toBe('');
    await sw.evaluate(phase => {
      const flags = globalThis as typeof globalThis & { a2Phase?: string };
      if (phase === 'before-commit') {
        const add = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
          const request = add.apply(this, args);
          if (this.name === 'sourceRefs') {
            flags.a2Phase = phase; const store = this;
            const pump = () => { store.get('test-only').onsuccess = pump; }; pump();
          }
          return request;
        };
      } else {
        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
          descriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
            if (this.mode === 'readwrite' && this.objectStoreNames.contains('sourceRefs')) { flags.a2Phase = phase; return; }
            callback?.call(this, event);
          });
        } });
      }
    }, phase);
    await select(); await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
    await expect.poll(() => sw.evaluate(() => (globalThis as typeof globalThis & { a2Phase?: string }).a2Phase)).toBe(phase);
    await cdp.send('ServiceWorker.stopWorker', { versionId }); await cdp.detach();
    const stopped = await state(); expect(stopped.knowledgeItems).toHaveLength(phase === 'before-commit' ? 0 : 1);
    await expect(page.getByText(/Selection save unavailable: WRITE_UNCONFIRMED/)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Retry same selection' }).click();
    await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
    const data = await state(); for (const key of ['knowledgeItems', 'knowledgeRevisions', 'sourceRefs', 'captures', 'messages', 'messageRevisions', 'requestReceipts'] as const) expect(data[key]).toHaveLength(1);
    expect(data.meta[0]!.dataSeq).toBe(1);
  });
}

test('a different source document cannot open, endorse or undo another capture intent', async () => {
  await select(); await keep(); const data = await state();
  const other = await context.newPage(); await other.goto(url); await other.evaluate(() => { document.title = 'Other synthetic document'; });
  const results = await sw.evaluate(async ({ generation, savedRequestId }) => {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); const tab = tabs.find(tab => tab.title === 'Other synthetic document')!;
    const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [0] }, args: [generation, savedRequestId], func: async (generation, savedRequestId) => {
      return Promise.all([
        chrome.runtime.sendMessage({ protocolVersion: 1, type: 'OpenSelection', generation, savedRequestId }),
        ...['UndoSelection', 'EndorseSelection'].map(type => chrome.runtime.sendMessage({ protocolVersion: 1, type, generation, savedRequestId, expectedRecordVersion: 1, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString() })),
      ]);
    } }); return injected[0]!.result;
  }, { generation: data.meta[0]!.generation, savedRequestId: data.knowledgeItems[0]!.createdByRequestId });
  expect(results).toHaveLength(3); for (const result of results as { ok: boolean; code: string }[]) expect(result).toMatchObject({ ok: false, code: 'UNAUTHORIZED_CONTEXT' });
  expect((await state()).meta[0]!.dataSeq).toBe(1);
});

test('deduplicated save receipt cannot undo the pre-existing note, even from trusted UI', async () => {
  await select(); await keep(); await closeFeedback(); await select(); await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
  await expect(page.getByText('Already saved. Your existing note was kept unchanged.', { exact: true })).toBeVisible();
  const data = await state(); const duplicate = data.requestReceipts.find(receipt => receipt.result.created === false)!;
  expect(await library.evaluate(command => chrome.runtime.sendMessage(command), { protocolVersion: 1, type: 'UndoSelection', generation: data.meta[0]!.generation, savedRequestId: duplicate.requestId,
    expectedRecordVersion: 1, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString() })).toMatchObject({ ok: false, code: 'UNDO_NOT_CREATED' });
  expect((await state()).knowledgeItems).toHaveLength(1);
});

test('untrusted source markup is inert in kept body and local excerpt, with no automatic network requests', async () => {
  const requests: string[] = []; context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const hostile = '<img src="https://evil.test/image" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n![secret](https://evil.test/image)';
  await page.locator('#code-text').evaluate((node, text) => { node.textContent = text; }, hostile); await select(); await keep();
  await library.getByRole('button', { name: 'Refresh library' }).click(); await library.getByRole('button', { name: 'ChatGPT selection', exact: true }).click();
  await expect(library.locator('.source-excerpt pre')).toHaveText(hostile);
  await library.locator('summary').filter({ hasText: /^Sources \(/ }).click();
  expect(await library.locator('.source-excerpt img,.source-excerpt script,.markdown img,.markdown script').count()).toBe(0);
  expect(requests).toEqual([]);
});

for (const nav of ['spa-push', 'spa-push-back'] as const) {
  test(`keep selection succeeds after ChatGPT sidebar SPA navigation (${nav})`, async () => {
    await select(); await keep(); await closeFeedback();
    const priorSourceIds = new Set((await state()).sourceRefs.map(source => source.id));
    if (nav === 'spa-push') { await page.evaluate(() => { history.pushState({}, '', '/c/synthetic-a1'); }); await expect(page).toHaveURL('https://chatgpt.com/c/synthetic-a1'); }
    else { await page.evaluate(() => { history.pushState({}, '', '/c/synthetic-a1'); history.pushState({}, '', '/c/synthetic-a0'); }); await expect(page).toHaveURL('https://chatgpt.com/c/synthetic-a0'); }
    await select('answer-text');
    await expect(page.getByRole('button', { name: 'Keep selection', exact: true })).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
    await expect(page.locator('#akm-a0-probe')).toContainText(/Saved to Knowledge|Selection save unavailable|Preview unavailable/, { timeout: 15000 });
    const probeText = await page.locator('#akm-a0-probe').evaluate(el => (el as HTMLElement).shadowRoot?.textContent ?? '');
    expect(probeText, `Expected save success but got: ${probeText ?? '(empty)'}`).toMatch(/Saved to Knowledge/);
    const data = await state(); expect(data.knowledgeItems).toHaveLength(2);
    const added = data.sourceRefs.filter(source => !priorSourceIds.has(source.id));
    expect(added).toHaveLength(1);
    expect(added[0]!.sourceUrl).toBe(nav === 'spa-push' ? 'https://chatgpt.com/c/synthetic-a1' : 'https://chatgpt.com/c/synthetic-a0');
  });
}

test('keep and endorse survive consecutive ChatGPT sidebar SPA navigations A→B→A', async () => {
  await select(); await keep(); await closeFeedback();
  await page.evaluate(() => { history.pushState({}, '', '/c/synthetic-a1'); });
  await select('answer-text'); await keep(); await closeFeedback();
  await page.evaluate(() => { history.pushState({}, '', '/c/synthetic-a0'); });
  await select('answer-text'); await keep();
  await page.getByRole('button', { name: 'Endorse', exact: true }).click();
  await expect(page.getByText('Endorsed. Your approval is recorded in saved history.')).toBeVisible();
  expect((await state()).knowledgeItems).toHaveLength(3);
  expect((await state()).knowledgeItems.filter(n => n.reviewState === 'endorsed')).toHaveLength(1);
});
