import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import type { KnowledgeItem, KnowledgeRevision, LibraryMeta, RequestReceipt, SaveManualNote, LibraryReply } from '../../src/shared/knowledge';

let context: BrowserContext, library: Page, sw: Worker, profile: string, extensionId: string, generation: string;
async function launch() {
  const path = resolve('dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`] });
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(sw.url()).host;
  library = await context.newPage(); await library.goto(`chrome-extension://${extensionId}/library.html`);
  await expect(library.getByText('Local library ready.', { exact: true })).toBeVisible();
  generation = await library.evaluate(async () => (await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).library.generation);
}
test.beforeEach(async () => {
  await mkdir('.cache/profiles', { recursive: true }); profile = await mkdtemp(resolve('.cache/profiles/a1-')); await launch();
});
test.afterEach(async () => {
  await context?.close();
  const child = relative(resolve('.cache/profiles'), resolve(profile));
  if (!child.startsWith('a1-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe profile cleanup');
  await rm(resolve(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const body = 'A🧠中文\n\n```sh\n  echo "hello"  \n\t# preserve spaces\n```\n';
function intent(): SaveManualNote {
  return { protocolVersion: 1, type: 'SaveManualNote', requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), generation, noteId: null, expectedRecordVersion: null,
    fields: { title: 'Offline note', bodyMarkdown: body, type: 'personal_note', tags: ['code', '中文'], personalExplanation: 'Why this matters', applicableVersion: 'v1', reviewAfter: '2026-12-01' } };
}
async function send(command: unknown, page = library): Promise<LibraryReply> { return page.evaluate(command => chrome.runtime.sendMessage(command), command); }
async function snapshot() {
  return library.evaluate(async generation => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(`akm-library-${generation}`); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    try {
      const names = ['knowledgeItems', 'knowledgeRevisions', 'meta', 'requestReceipts'];
      const tx = db.transaction(names, 'readonly');
      const data = await Promise.all(names.map(name => new Promise<unknown[]>((resolve, reject) => { const req = tx.objectStore(name).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); })));
      return { notes: data[0] as KnowledgeItem[], revisions: data[1] as KnowledgeRevision[], meta: data[2]![0] as LibraryMeta, receipts: data[3] as RequestReceipt[] };
    } finally { db.close(); }
  }, generation);
}
async function uiSave(page = library) {
  await page.getByLabel('Title (optional)').fill('Offline note'); await page.getByLabel('Body (Markdown)').fill(body);
  await page.getByRole('button', { name: 'Save note', exact: true }).click(); await expect(page.getByText(/Saved to Knowledge · version/)).toBeVisible();
}

test('manual note, exact fields and immutable history survive full browser restart offline', async () => {
  const requests: string[] = []; context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await context.setOffline(true);
  await uiSave();
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByText('Metadata and editing tools', { exact: true }).click();
  await library.getByLabel('Personal explanation').fill('My explanation');
  await library.getByLabel('Body (Markdown)').fill(body + 'second version');
  await library.getByRole('button', { name: 'Save note', exact: true }).click(); await expect(library.getByText('Saved to Knowledge · version 2.')).toBeVisible();
  const before = await snapshot(); expect(before.notes).toHaveLength(1); expect(before.revisions).toHaveLength(2);
  expect(before.revisions.find(row => row.version === 1)!.snapshot.bodyMarkdown).toBe(body);
  expect(before.notes[0]!.sourceKind).toBe('manual'); expect(before.notes[0]!.reviewState).toBe('saved');
  expect(before.meta.dataSeq).toBe(2); expect(before.receipts).toHaveLength(2); expect(requests).toEqual([]);
  expect(await sw.evaluate(() => chrome.permissions.contains({ origins: ['https://chatgpt.com/*'] }))).toBe(false);
  await context.close(); await launch();
  expect(await snapshot()).toEqual(before);
  await library.getByRole('button', { name: 'Offline note', exact: true }).click();
  await expect(library.locator('.note-reading')).toContainText('second version');
  await library.getByText('Saved history (2 versions)').click();
  await library.getByRole('button', { name: 'View version 1', exact: true }).click();
  await expect(library.getByRole('article', { name: 'Saved revision' }).locator('code')).toHaveText('  echo "hello"  \n\t# preserve spaces');
});

test('same intent retries once, changed payload fails, and stale or expired intents cannot write', async () => {
  const command = intent();
  const results = await Promise.all([send(command), send(command), send(command)]);
  expect(results.every(reply => reply.ok)).toBe(true);
  expect(results.filter(reply => reply.ok && 'result' in reply && !reply.result.deduplicated)).toHaveLength(1);
  expect(await send({ ...command, fields: { ...command.fields, bodyMarkdown: 'different' } })).toMatchObject({ ok: false, code: 'REQUEST_ID_REUSED' });
  expect(await send({ ...intent(), generation: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'GENERATION_CHANGED' });
  expect(await send({ ...intent(), issuedAt: new Date(Date.now() - 31 * 86400000).toISOString() })).toMatchObject({ ok: false, code: 'INTENT_EXPIRED' });
  expect(await send({ ...intent(), noteId: crypto.randomUUID(), expectedRecordVersion: 1 })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  const state = await snapshot(); expect(state.notes).toHaveLength(1); expect(state.revisions).toHaveLength(1); expect(state.receipts).toHaveLength(1); expect(state.meta.dataSeq).toBe(1);
});

test('two editors detect conflict, retain losing draft and show the latest version', async () => {
  await uiSave();
  const second = await context.newPage(); await second.goto(`chrome-extension://${extensionId}/library.html`);
  await second.getByRole('button', { name: 'Offline note', exact: true }).click();
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await second.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('Winning edit');
  await second.getByLabel('Body (Markdown)').fill('Losing draft');
  await library.getByRole('button', { name: 'Save note', exact: true }).click(); await expect(library.getByText('Saved to Knowledge · version 2.')).toBeVisible();
  await second.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText('VERSION_CONFLICT');
  await expect(second.getByLabel('Body (Markdown)')).toHaveValue('Losing draft');
  await expect(second.locator('.conflict')).toContainText('Winning edit');
  expect((await snapshot()).meta.dataSeq).toBe(2);
  await second.getByRole('button', { name: 'Keep my draft against this version' }).click();
  await second.getByRole('button', { name: 'Save note', exact: true }).click(); await expect(second.getByText('Saved to Knowledge · version 3.')).toBeVisible();
  expect((await snapshot()).notes[0]!.bodyMarkdown).toBe('Losing draft');
});

test('native storage failure aborts all rows and retains draft with a visible retry', async () => {
  await sw.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
      if (this.name === 'knowledgeRevisions') throw new DOMException('synthetic full disk', 'QuotaExceededError');
      return add.apply(this, args);
    };
    (globalThis as typeof globalThis & { restoreA1?: () => void }).restoreA1 = () => { IDBObjectStore.prototype.add = add; };
  });
  await library.getByLabel('Body (Markdown)').fill(body);
  await library.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(library.getByRole('alert')).toContainText('STORAGE_FULL'); await expect(library.getByLabel('Body (Markdown)')).toHaveValue(body);
  const state = await snapshot(); expect(state.notes).toHaveLength(0); expect(state.revisions).toHaveLength(0); expect(state.receipts).toHaveLength(0); expect(state.meta.dataSeq).toBe(0);
  await sw.evaluate(() => (globalThis as typeof globalThis & { restoreA1?: () => void }).restoreA1!());
  await library.getByRole('button', { name: 'Retry same save' }).click(); await expect(library.getByText('Saved to Knowledge · version 1.')).toBeVisible();
  expect((await snapshot()).notes).toHaveLength(1);
});

for (const phase of ['before-commit', 'after-commit'] as const) {
  test(`worker termination ${phase} retries the same intent without duplicate or partial records`, async () => {
    test.setTimeout(60000);
    const cdp = await context.newCDPSession(library);
    let versionId = '';
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      const current = versions.find((version: { scriptURL: string; runningStatus: string }) => version.scriptURL === sw.url() && version.runningStatus === 'running');
      if (current) versionId = current.versionId;
    });
    await cdp.send('ServiceWorker.enable'); await expect.poll(() => versionId).not.toBe('');
    await sw.evaluate(phase => {
      const flags = globalThis as typeof globalThis & { a1Phase?: string; a1Durability?: string };
      if (phase === 'before-commit') {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
          const request = put.apply(this, args);
          if (this.name === 'knowledgeItems') {
            flags.a1Phase = 'before-commit'; flags.a1Durability = this.transaction.durability;
            const store = this;
            // Native request chain keeps this transaction active until termination.
            const pump = () => { store.get('test-only-keepalive').onsuccess = pump; }; pump();
          }
          return request;
        };
      } else {
        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
          descriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
            if (this.mode === 'readwrite' && this.objectStoreNames.contains('knowledgeItems')) {
              flags.a1Phase = 'after-commit'; flags.a1Durability = this.durability;
              return; // Suppress Dexie's commit notification, BEFORE response ack.
            }
            callback?.call(this, event);
          });
        } });
      }
    }, phase);
    const command = intent();
    await library.evaluate(command => { void chrome.runtime.sendMessage(command).catch(() => undefined); }, command);
    await expect.poll(() => sw.evaluate(() => (globalThis as typeof globalThis & { a1Phase?: string }).a1Phase)).toBe(phase);
    expect(await sw.evaluate(() => (globalThis as typeof globalThis & { a1Durability?: string }).a1Durability)).toBe('strict');
    await cdp.send('ServiceWorker.stopWorker', { versionId });
    await cdp.detach();
    const stoppedState = await snapshot();
    expect(stoppedState.notes).toHaveLength(phase === 'before-commit' ? 0 : 1);
    expect(stoppedState.meta.dataSeq).toBe(phase === 'before-commit' ? 0 : 1);
    const result = await send(command); expect(result).toMatchObject({ ok: true, result: { deduplicated: phase === 'after-commit' } });
    const state = await snapshot(); expect(state.notes).toHaveLength(1); expect(state.revisions).toHaveLength(1); expect(state.receipts).toHaveLength(1); expect(state.meta.dataSeq).toBe(1);
    expect(await send(command)).toMatchObject({ ok: true, result: { deduplicated: true } });
  });
}

test('hostile stored Markdown remains inert without network in detail and history', async () => {
  const requests: string[] = []; context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const hostile = '<img src="https://evil.test/raw" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n![remote](https://evil.test/image)\n\n[run](javascript:alert(1))\n\n[internal](chrome://settings)\n\n[safe](https://example.com/path?utm_source=test)';
  await send({ ...intent(), fields: { ...intent().fields, bodyMarkdown: hostile } });
  await library.getByRole('button', { name: 'Refresh library' }).click(); await library.getByRole('button', { name: 'Offline note', exact: true }).click();
  expect(await library.locator('.markdown img,.markdown script,.markdown iframe,.markdown style').count()).toBe(0);
  await expect(library.locator('.markdown')).toContainText('[Image not loaded: remote]');
  expect(await library.locator('.markdown a').getAttribute('href')).toBe('https://example.com/path');
  await library.getByText('Saved history (1 versions)').click(); await library.getByRole('button', { name: 'View version 1', exact: true }).click();
  expect(await library.locator('.markdown img,.markdown script,.markdown iframe').count()).toBe(0); expect(requests).toEqual([]);
  await library.setViewportSize({ width: 360, height: 800 });
  expect(await library.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await library.screenshot({ path: 'artifacts/a1-library-360.png', fullPage: true });
});

test('failure at the final receipt write rolls back note, history and sequence together', async () => {
  await sw.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
      if (this.name === 'requestReceipts') throw new DOMException('synthetic final write abort', 'AbortError');
      return add.apply(this, args);
    };
  });
  expect(await send(intent())).toMatchObject({ ok: false, code: 'WRITE_FAILED' });
  const state = await snapshot(); expect(state.notes).toHaveLength(0); expect(state.revisions).toHaveLength(0); expect(state.receipts).toHaveLength(0); expect(state.meta.dataSeq).toBe(0);
});

test('uncertain acknowledgement and failed reopening keep the original create intent in the UI', async () => {
  await library.evaluate(() => {
    const runtime = chrome.runtime as unknown as { sendMessage(command: { type: string }): Promise<unknown> };
    const send = runtime.sendMessage.bind(runtime);
    let hideAck = true, hideRead = true;
    runtime.sendMessage = async command => {
      const result = await send(command);
      if (command.type === 'SaveManualNote' && hideAck) { hideAck = false; throw new Error('synthetic lost ack'); }
      if (command.type === 'GetNote' && hideRead) { hideRead = false; throw new Error('synthetic lost read'); }
      return result;
    };
  });
  await library.getByLabel('Body (Markdown)').fill(body); await library.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(library.getByText('Save committed, but the saved note could not be reopened. Retry the same save to reopen it.', { exact: false })).toBeVisible();
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue(body);
  await library.getByRole('button', { name: 'Retry same save' }).click();
  await expect(library.getByText('Saved to Knowledge · version 1 · retry confirmed.')).toBeVisible();
  const state = await snapshot(); expect(state.notes).toHaveLength(1); expect(state.meta.dataSeq).toBe(1); expect(state.receipts).toHaveLength(1);
});

async function mutate(action: 'fence' | 'unfence' | 'remove-result' | 'remove-history' | 'expire-receipt') {
  await library.evaluate(async ({ generation, action }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(`akm-library-${generation}`); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['meta', 'knowledgeItems', 'knowledgeRevisions', 'requestReceipts'], 'readwrite', { durability: 'strict' });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        if (action === 'remove-result') { tx.objectStore('knowledgeItems').clear(); tx.objectStore('knowledgeRevisions').clear(); }
        else if (action === 'remove-history') tx.objectStore('knowledgeRevisions').clear();
        else if (action === 'expire-receipt') {
          const store = tx.objectStore('requestReceipts'); const request = store.getAll();
          request.onsuccess = () => { for (const row of request.result) store.put({ ...row, expiresAt: Date.now() - 1, issuedAt: new Date(Date.now() - 31 * 86400000).toISOString() }); };
        } else {
          const store = tx.objectStore('meta'); const request = store.get('library');
          request.onsuccess = () => store.put({ ...request.result, writeFence: action === 'fence' ? { kind: 'restore', operationId: crypto.randomUUID() } : null });
        }
      });
    } finally { db.close(); }
  }, { generation, action });
}

test('maintenance fence rejects reads, writes and receipt retries until released', async () => {
  const command = intent(); await send(command); const before = await snapshot();
  await mutate('fence');
  expect(await send(command)).toMatchObject({ ok: false, code: 'LIBRARY_BUSY' });
  expect(await send(intent())).toMatchObject({ ok: false, code: 'LIBRARY_BUSY' });
  expect(await send({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).toMatchObject({ ok: false, code: 'LIBRARY_BUSY' });
  await mutate('unfence'); expect(await snapshot()).toEqual(before);
  expect(await send(command)).toMatchObject({ ok: true, result: { deduplicated: true } });
});

test('deleted results cannot be recreated by retry and missing history prevents an edit', async () => {
  const command = intent(); const result = await send(command);
  if (!result.ok || !('result' in result)) throw new Error('save failed');
  await mutate('remove-history');
  expect(await send({ ...intent(), noteId: result.result.knowledgeId, expectedRecordVersion: 1 })).toMatchObject({ ok: false, code: 'LIBRARY_CORRUPT' });
  await mutate('remove-result');
  expect(await send(command)).toMatchObject({ ok: false, code: 'RESULT_REMOVED' });
  expect((await snapshot()).notes).toHaveLength(0);
  expect(await send(intent())).toMatchObject({ ok: true, result: { deduplicated: false } });
});

test('expired receipts are pruned during activity without pruning canonical history', async () => {
  await send(intent()); await mutate('expire-receipt'); await send(intent());
  const state = await snapshot(); expect(state.notes).toHaveLength(2); expect(state.revisions).toHaveLength(2); expect(state.receipts).toHaveLength(1); expect(state.meta.dataSeq).toBe(2);
});

test('native optional identity keys permit unknowns and enforce scoped known uniqueness', async () => {
  const results = await library.evaluate(async generation => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(`akm-library-${generation}`); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    try {
      function write(store: string, rows: object[]) { return new Promise<string>(resolve => {
        const tx = db.transaction(store, 'readwrite'); tx.oncomplete = () => resolve('committed'); tx.onabort = () => resolve(tx.error?.name ?? 'aborted');
        rows.forEach(row => tx.objectStore(store).add(row));
      }); }
      return {
        unknown: await write('messages', [{ id: 'u1', conversationId: 'a', sourceMessageId: null }, { id: 'u2', conversationId: 'a', sourceMessageId: null }]),
        known: await write('messages', [{ id: 'k1', conversationId: 'a', sourceMessageId: 'known' }, { id: 'k2', conversationId: 'b', sourceMessageId: 'known' }]),
        duplicate: await write('messages', [{ id: 'k3', conversationId: 'a', sourceMessageId: 'known' }]),
        absentCuration: await write('knowledgeItems', [{ id: 'n1', curationKey: null }, { id: 'n2', curationKey: null }]),
        knownCuration: await write('knowledgeItems', [{ id: 'n3', curationKey: 'known' }]),
        duplicateCuration: await write('knowledgeItems', [{ id: 'n4', curationKey: 'known' }]),
        revisions: await write('messageRevisions', [{ id: 'r1', messageId: 'k1', contentHash: 'hash' }, { id: 'r2', messageId: 'k2', contentHash: 'hash' }]),
        duplicateRevision: await write('messageRevisions', [{ id: 'r3', messageId: 'k1', contentHash: 'hash' }]),
      };
    } finally { db.close(); }
  }, generation);
  expect(results).toEqual({ unknown: 'committed', known: 'committed', duplicate: 'ConstraintError', absentCuration: 'committed', knownCuration: 'committed', duplicateCuration: 'ConstraintError', revisions: 'committed', duplicateRevision: 'ConstraintError' });
});

test('active generation change closes old handles and rejects commands carrying the old token', async () => {
  const old = generation; const command = intent(); await send(command);
  const next = crypto.randomUUID();
  // Exercise the pointer contract only. This is a test-created empty generation,
  // NOT an implementation or claim of the staged A6 restore workflow.
  await mutate('fence');
  await sw.evaluate(next => chrome.storage.local.set({ activeLibrary: { generation: next, ready: false } }), next);
  const reply = await send({ protocolVersion: 1, type: 'ListNotes', offset: 0 });
  expect(reply).toMatchObject({ ok: true, library: { generation: next, total: 0 } });
  expect(await send({ ...intent(), generation: old })).toMatchObject({ ok: false, code: 'GENERATION_CHANGED' });
  expect(await send({ ...intent(), generation: next })).toMatchObject({ ok: true });
});

test('a missing active database is reported without silently replacing it', async () => {
  const missing = crypto.randomUUID();
  await sw.evaluate(missing => chrome.storage.local.set({ activeLibrary: { generation: missing, ready: true } }), missing);
  expect(await send({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).toMatchObject({ ok: false, code: 'STORAGE_MISSING' });
  expect(await library.evaluate(async missing => (await indexedDB.databases()).some(db => db.name === `akm-library-${missing}`), missing)).toBe(false);
});

test('versionchange releases old handles and a newer schema is never reset', async () => {
  await send(intent()); const before = await snapshot();
  await library.evaluate(async generation => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`akm-library-${generation}`, 20); // Dexie v1 uses native v10.
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Versionchange did not release the connection'));
    });
  }, generation);
  expect(await send({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).toMatchObject({ ok: false, code: 'SCHEMA_TOO_NEW' });
  expect(await snapshot()).toEqual(before);
});

test('bounded Unicode notes keep exact text; strict-commit latency is recorded', async ({}, testInfo) => {
  const durations: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now(); expect(await send(intent())).toMatchObject({ ok: true }); durations.push(performance.now() - start);
  }
  const large = '🧠'.repeat(256 * 1024 / 4);
  const command = intent(); command.fields.bodyMarkdown = large;
  expect(await send(command)).toMatchObject({ ok: true });
  expect(await send({ ...intent(), fields: { ...command.fields, bodyMarkdown: large + 'x' } })).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  const state = await snapshot(); expect(state.notes.find(note => note.createdByRequestId === command.requestId)!.bodyMarkdown).toBe(large);
  expect(state.meta.dataSeq).toBe(21);
  durations.sort((a, b) => a - b);
  await testInfo.attach('strict-save-latency', { body: JSON.stringify({ browser: context.browser()?.version(), samples: durations.length, p50Ms: durations[9], p95Ms: durations[18], maxMs: durations[19], noteBytes: new TextEncoder().encode(body).length, includes: 'UI messaging, hashing, strict IDB commit and reply; warm disposable Chromium profile' }), contentType: 'application/json' });
});
