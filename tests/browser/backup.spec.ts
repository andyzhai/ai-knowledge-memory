import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { makeBackup, validateBackup, type Backup, TRANSFER_CHARS } from '../../src/shared/backup';

let context: BrowserContext, library: Page, profile: string, generation: string, extensionId: string;
async function launch() {
  const extension = resolve('.cache/authorized-extension');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(sw.url()).host;
  library = await context.newPage(); await library.goto(`chrome-extension://${extensionId}/library.html`);
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(library.getByRole('heading', { name: 'Backup and restore' })).toBeVisible();
  const result = await send('ListNotes', { offset: 0 }); if (result.ok) generation = result.library.generation;
}
test.beforeEach(async () => { await mkdir('.cache/profiles', { recursive: true }); profile = await mkdtemp(resolve('.cache/profiles/a6-')); await launch(); });
test.afterEach(async () => { await context?.close(); const child = relative(resolve('.cache/profiles'), resolve(profile)); if (!child.startsWith('a6-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe profile cleanup'); await rm(resolve(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function send(type: string, fields: Record<string, unknown> = {}) { return library.evaluate(c => chrome.runtime.sendMessage(c), { protocolVersion: 1, type, ...fields }); }
async function create(title: string, body = 'Exact code\n\n```ts\nconst x = "中文";\n```') {
  const fields = { generation, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId: null, expectedRecordVersion: null, fields: { title, bodyMarkdown: body, type: 'personal_note', tags: ['backup'], personalExplanation: 'Because', applicableVersion: 'v1', reviewAfter: null } };
  const reply = await send('SaveManualNote', fields); expect(reply.ok).toBe(true); return { id: reply.result.knowledgeId as string, fields };
}
async function exported(type = 'ExportBackup', fields: Record<string, unknown> = {}) {
  const begin = await send(type, fields); expect(begin.ok, JSON.stringify(begin)).toBe(true); let text = '';
  for (let index = 0; index < begin.backup.chunks; index++) { const reply = await send('ReadBackupChunk', { transferId: begin.backup.transferId, index }); expect(reply.ok).toBe(true); text += reply.backup.text; }
  await send('ReleaseBackupTransfer', { transferId: begin.backup.transferId }); return text;
}
async function preview(text: string) {
  const begin = await send('BeginBackupUpload', { bytes: Buffer.byteLength(text) }); expect(begin.ok).toBe(true);
  for (let start = 0, index = 0; start < text.length; start += TRANSFER_CHARS, index++) expect((await send('UploadBackupChunk', { transferId: begin.backup.transferId, index, text: text.slice(start, start + TRANSFER_CHARS) })).ok).toBe(true);
  return send('PreviewRestore', { transferId: begin.backup.transferId });
}
async function state() { return library.evaluate(async () => ({ settings: await chrome.storage.local.get(null), databases: await indexedDB.databases() })); }

test('canonical round-trip into empty library and replace clears two views and rejects stale saves', async () => {
  const first = await create('Original'), second = await create('Replacement');
  await send('ReviewNote', { generation, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId: first.id, expectedRecordVersion: 1, state: 'superseded', supersededById: second.id });
  const text = await exported(), backup = JSON.parse(text) as Backup;
  const secondView = await context.newPage(); await secondView.goto(`chrome-extension://${extensionId}/library.html?note=${first.id}`);
  await expect(secondView.locator('.note-reading')).toContainText('Exact code');
  const p = await preview(text); expect(p.ok, JSON.stringify(p)).toBe(true);
  const old = generation;
  expect((await send('ConfirmRestore', { operationId: p.backup.preview.operationId, mode: 'replace' })).ok).toBe(true);
  await expect(secondView.getByLabel('Body (Markdown)')).toHaveValue('');
  expect(await send('SaveManualNote', first.fields)).toMatchObject({ ok: false, code: 'GENERATION_CHANGED' });
  let after = JSON.parse(await exported()) as Backup; expect(after.records).toEqual(backup.records); expect(after.libraryId).toBe(backup.libraryId);
  expect((await state()).databases.map(d => d.name)).not.toContain(`akm-library-${old}`);
  generation = (await send('ListNotes', { offset: 0 })).library.generation;
  const deletion = await send('PreviewDeletion', { generation, target: { kind: 'all' } });
  expect((await send('DeleteLibraryData', { generation, target: { kind: 'all' }, expectedDataSeq: deletion.preview.dataSeq, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString() })).ok).toBe(true);
  const empty = await preview(text); expect(empty.ok).toBe(true); expect((await send('ConfirmRestore', { operationId: empty.backup.preview.operationId, mode: 'empty' })).ok).toBe(true);
  after = JSON.parse(await exported()); expect(after.records).toEqual(backup.records);
  await context.close(); await launch(); expect((JSON.parse(await exported()) as Backup).records).toEqual(backup.records);
});

test('captured sources, loaded coverage, review history and detached sources round-trip; grants never transfer', async () => {
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-synthetic.html' }));
  await library.getByRole('button', { name: 'Enable ChatGPT' }).click();
  const page = await context.newPage(); await page.goto('https://chatgpt.com/c/synthetic-a0'); await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await page.locator('#answer-text').evaluate(node => { const r = document.createRange(); r.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
  await page.getByRole('button', { name: 'Keep selection', exact: true }).click(); await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save loaded conversation', exact: true }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click(); await expect(page.getByText(/Saved 3 loaded messages/)).toBeVisible();
  const text = await exported(), original = JSON.parse(text) as Backup;
  for (const change of ['source-hash', 'provider', 'unsafe-url'] as const) {
    const bad = structuredClone(original);
    if (change === 'source-hash') bad.records.messageRevisions[0]!.contentHash = '0'.repeat(64);
    if (change === 'provider') bad.records.sourceRefs[0]!.sourceProvider = 'gemini';
    if (change === 'unsafe-url') bad.records.sourceRefs[0]!.sourceUrl = 'javascript:alert(1)';
    expect(await preview(JSON.stringify(await makeBackup(bad.records, bad.libraryId, bad.dataSeq)))).toMatchObject({ ok: false, code: 'BACKUP_INVALID' });
  }
  const p = await preview(text); expect(p.ok, JSON.stringify(p)).toBe(true);
  expect((await send('ConfirmRestore', { operationId: p.backup.preview.operationId, mode: 'replace' })).ok).toBe(true);
  const after = JSON.parse(await exported()) as Backup;
  expect(after.records).toEqual({ ...original.records, connections: original.records.connections.map(c => ({ ...c, enabled: false })) });
  expect((await send('GetStatus')).status.enabled).toBe(false); expect(after.records.captures.every(c => !('owner' in c) && !('acceptedBatches' in c))).toBe(true);
  generation = (await send('ListNotes', { offset: 0 })).library.generation;
  const target = { kind: 'conversation', conversationId: original.records.conversations[0]!.id, mode: 'keep_knowledge' }, d = await send('PreviewDeletion', { generation, target });
  expect((await send('DeleteLibraryData', { generation, target, expectedDataSeq: d.preview.dataSeq, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString() })).ok).toBe(true);
  const detached = await exported(), dp = await preview(detached); expect(dp.ok, JSON.stringify(dp)).toBe(true);
  expect((await send('ConfirmRestore', { operationId: dp.backup.preview.operationId, mode: 'replace' })).ok).toBe(true);
  expect((JSON.parse(await exported()) as Backup).records).toEqual((JSON.parse(detached) as Backup).records);
});

test('invalid, newer, unsafe, duplicate and checksum-valid broken graph inputs leave active records unchanged', async () => {
  await create('Preserve me'); const text = await exported(), b = JSON.parse(text) as Backup;
  const bad = structuredClone(b); bad.records.knowledgeRevisions[0]!.knowledgeId = crypto.randomUUID();
  const invalid = [text.slice(0, -1), '['.repeat(33) + ']'.repeat(33), '{"__proto__":{}}', JSON.stringify({ ...b, schemaVersion: 2 }), text.replace('Preserve me', 'tamper'), JSON.stringify(await makeBackup(bad.records, bad.libraryId, bad.dataSeq))];
  for (const candidate of invalid) { expect((await preview(candidate)).ok).toBe(false); expect((JSON.parse(await exported()) as Backup).records).toEqual(b.records); }
  expect(await send('BeginBackupUpload', { bytes: 200 * 1024 * 1024 + 1 })).toMatchObject({ ok: false, code: 'BACKUP_TOO_LARGE' });
  expect((await state()).settings).not.toHaveProperty('restoreOperation');
});

test('stale preview and empty-only restore cannot replace current writes', async () => {
  await create('Existing'); const text = await exported(), p = await preview(text); expect(p.ok).toBe(true);
  await create('Saved after preview');
  expect(await send('ConfirmRestore', { operationId: p.backup.preview.operationId, mode: 'replace' })).toMatchObject({ ok: false, code: 'PREVIEW_CHANGED' });
  expect((JSON.parse(await exported()) as Backup).counts.knowledgeItems).toBe(2);
  const p2 = await preview(text); expect(p2.ok).toBe(true);
  expect(await send('ConfirmRestore', { operationId: p2.backup.preview.operationId, mode: 'empty' })).toMatchObject({ ok: false, code: 'LIBRARY_NOT_EMPTY' });
  expect((await create('Still usable')).id).toBeTruthy();
});

for (const phase of ['staging', 'prepared', 'fenced', 'pointer-switched', 'activated'] as const) {
  test(`worker restart recovers ${phase} according to the durable pointer`, async () => {
    await create('Backup content'); const text = await exported(); await create('Old-only content');
    const p = await preview(text); expect(p.ok).toBe(true);
    await library.evaluate(async phase => {
      const settings = await chrome.storage.local.get('restoreOperation'), op = settings.restoreOperation as { operationId: string; oldGeneration: string; newGeneration: string; phase: string };
      const open = (g: string) => new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(`akm-library-${g}`); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      if (phase === 'staging') {
        const db = await open(op.newGeneration); await new Promise<void>((resolve, reject) => { const tx = db.transaction(['meta', 'knowledgeItems'], 'readwrite'); tx.objectStore('knowledgeItems').clear(); const r = tx.objectStore('meta').get('library'); r.onsuccess = () => tx.objectStore('meta').put({ ...r.result, status: 'staging' }); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close(); op.phase = 'staging';
      }
      if (['fenced', 'pointer-switched', 'activated'].includes(phase)) {
        const db = await open(op.oldGeneration); await new Promise<void>((resolve, reject) => { const tx = db.transaction('meta', 'readwrite'), r = tx.objectStore('meta').get('library'); r.onsuccess = () => tx.objectStore('meta').put({ ...r.result, writeFence: { operationId: op.operationId, kind: 'restore' }, restore: { operationId: op.operationId, targetGeneration: op.newGeneration, phase: 'fenced' } }); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close(); op.phase = 'fenced';
      }
      if (['pointer-switched', 'activated'].includes(phase)) await chrome.storage.local.set({ activeLibrary: { generation: op.newGeneration, ready: true }, chatgptProbeEnabled: false });
      if (phase === 'activated') op.phase = 'activated';
      await chrome.storage.local.set({ restoreOperation: op });
    }, phase);
    await context.close(); await launch();
    const b = JSON.parse(await exported()) as Backup;
    expect(b.counts.knowledgeItems).toBe(['pointer-switched', 'activated'].includes(phase) ? 1 : 2);
    const s = await state(); expect(s.settings).not.toHaveProperty('restoreOperation'); expect(s.databases.filter(d => d.name?.startsWith('akm-library-'))).toHaveLength(1);
    expect((await create('Write after recovery')).id).toBeTruthy();
  });
}

test('blocked old handles disclose retained copies; retry cleans up without rollback', async () => {
  await create('Restored'); const text = await exported(); await create('Removed'); const p = await preview(text); expect(p.ok).toBe(true);
  await library.evaluate(async generation => { const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(`akm-library-${generation}`); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); (globalThis as unknown as { held: IDBDatabase }).held = db; db.onversionchange = () => {}; }, generation);
  const result = await send('ConfirmRestore', { operationId: p.backup.preview.operationId, mode: 'replace' }); expect(result).toMatchObject({ ok: false, code: 'CLEANUP_BLOCKED' });
  expect((await state()).settings).toHaveProperty('restoreOperation'); expect((await send('ListNotes', { offset: 0 })).library.total).toBe(1);
  expect(await send('ExportBackup')).toMatchObject({ ok: false, code: 'LIBRARY_BUSY' });
  await library.evaluate(() => (globalThis as unknown as { held: IDBDatabase }).held.close());
  expect((await send('ResumeMaintenance')).ok).toBe(true); expect((await state()).settings).not.toHaveProperty('restoreOperation');
});

test('download UI produces independently readable Markdown ZIP and canonical restore preview at 360px', async () => {
  await create('../Example 知识'); await create('Second'); await library.getByText('Restore a JSON backup', { exact: true }).click();
  await expect(library.getByText('No backup downloaded from this profile yet.')).toBeVisible();
  const downloadPromise = library.waitForEvent('download'); await library.getByRole('button', { name: 'Download backup' }).click(); const download = await downloadPromise;
  const bytes = await readFile((await download.path())!); expect((JSON.parse(bytes.toString()) as Backup).counts.knowledgeItems).toBe(2);
  await library.getByText('Export selected Knowledge as Markdown', { exact: true }).click(); await library.getByRole('checkbox', { name: '../Example 知识', exact: true }).check(); await library.getByRole('checkbox', { name: 'Second', exact: true }).check();
  const zipPromise = library.waitForEvent('download'); await library.getByRole('button', { name: 'Download selected Markdown ZIP' }).click(); const zip = await zipPromise;
  const zipBytes = await readFile((await zip.path())!); await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/a6-markdown.zip', zipBytes);
  expect(zipBytes.readUInt32LE(0)).toBe(0x04034b50); expect(zipBytes.toString()).toContain('one-way export');
  await library.getByLabel('Choose canonical backup').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes });
  await expect(library.getByRole('region', { name: 'Restore preview' })).toBeVisible();
  await library.setViewportSize({ width: 360, height: 800 }); expect(await library.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await library.screenshot({ path: 'artifacts/a6-restore-preview-360.png', fullPage: true });
});

test('staging quota failure rolls back staging and leaves original library writable', async () => {
  await create('Keep original'); const text = await exported();
  const sw = context.serviceWorkers()[0]!;
  await sw.evaluate(() => {
    const add = IDBObjectStore.prototype.add; let once = true;
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) { if (once && this.name === 'knowledgeItems') { once = false; throw new DOMException('Synthetic disk exhaustion', 'QuotaExceededError'); } return add.apply(this, args); };
  });
  expect(await preview(text)).toMatchObject({ ok: false, code: 'STORAGE_FULL' });
  expect((JSON.parse(await exported()) as Backup).counts.knowledgeItems).toBe(1);
  expect((await state()).settings).not.toHaveProperty('restoreOperation'); expect((await create('Still writable')).id).toBeTruthy();
});

test('failed upgrade preserves data; newer schema permits read-only salvage with two views', async () => {
  await create('Recovery content'); const original = JSON.parse(await exported()) as Backup;
  const second = await context.newPage(); await second.goto(`chrome-extension://${extensionId}/library.html`);
  const upgrade = async (abort: boolean) => library.evaluate(async ({ generation, abort }) => new Promise<string>(resolve => {
    const request = indexedDB.open(`akm-library-${generation}`, 20);
    request.onupgradeneeded = () => { if (abort) request.transaction!.abort(); };
    request.onsuccess = () => { request.result.close(); resolve('upgraded'); }; request.onerror = () => resolve(request.error?.name ?? 'error'); request.onblocked = () => resolve('blocked');
  }), { generation, abort });
  expect(await upgrade(true)).toBe('AbortError'); expect((JSON.parse(await exported()) as Backup).records).toEqual(original.records);
  expect(await upgrade(false)).toBe('upgraded');
  expect(await send('ListNotes', { offset: 0 })).toMatchObject({ ok: false, code: 'SCHEMA_TOO_NEW' });
  const recovery = JSON.parse(await exported('ExportRecovery')); expect(recovery.format).toBe('akm-read-only-recovery'); expect(recovery.nativeVersion).toBe(20);
  expect(recovery.records.knowledgeItems).toEqual(original.records.knowledgeItems); expect(recovery.records.knowledgeRevisions).toEqual(original.records.knowledgeRevisions);
  expect(recovery.records).not.toHaveProperty('requestReceipts');
});

for (const stop of ['staging-write', 'before-pointer', 'after-pointer'] as const) {
  test(`actual service-worker termination at ${stop} preserves one complete library`, async () => {
    test.setTimeout(60000);
    await create('Imported content'); const text = await exported(); await create('Original-only');
    const sw = context.serviceWorkers()[0]!, cdp = await context.newCDPSession(library); let versionId = '';
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => { const version = versions.find(v => v.scriptURL === sw.url() && v.runningStatus === 'running'); if (version) versionId = version.versionId; });
    await cdp.send('ServiceWorker.enable'); await expect.poll(() => versionId).not.toBe('');
    const p = stop === 'staging-write' ? null : await preview(text); if (p) expect(p.ok).toBe(true);
    await sw.evaluate(stop => {
      const flags = globalThis as typeof globalThis & { restoreStop?: string };
      if (stop === 'staging-write') {
        const add = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
          const result = add.apply(this, args);
          if (this.name === 'knowledgeItems') { flags.restoreStop = stop; const store = this; const pump = () => { store.get('test-only').onsuccess = pump; }; pump(); }
          return result;
        };
      } else {
        const set = chrome.storage.local.set.bind(chrome.storage.local);
        chrome.storage.local.set = async items => {
          if ('activeLibrary' in items) {
            if (stop === 'after-pointer') await set(items);
            flags.restoreStop = stop; await new Promise(() => {}); return;
          }
          await set(items);
        };
      }
    }, stop);
    const pending = (stop === 'staging-write' ? preview(text) : send('ConfirmRestore', { operationId: p.backup.preview.operationId, mode: 'replace' })).catch(() => undefined);
    await expect.poll(() => sw.evaluate(() => (globalThis as typeof globalThis & { restoreStop?: string }).restoreStop)).toBe(stop);
    await cdp.send('ServiceWorker.stopWorker', { versionId }); await cdp.detach(); await pending;
    await expect.poll(async () => (await send('ListNotes', { offset: 0 })).ok, { timeout: 20000 }).toBe(true);
    const after = JSON.parse(await exported()) as Backup; expect(after.counts.knowledgeItems).toBe(stop === 'after-pointer' ? 1 : 2);
    expect((await state()).settings).not.toHaveProperty('restoreOperation');
    generation = (await send('ListNotes', { offset: 0 })).library.generation; expect((await create('Recovered writable')).id).toBeTruthy();
  });
}

test('maintenance fences and unfinished captures refuse export instead of making a partial backup', async () => {
  await create('Stable'); const before = await exported();
  await library.evaluate(async generation => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(`akm-library-${generation}`); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => { const tx = db.transaction('meta', 'readwrite'), r = tx.objectStore('meta').get('library'); r.onsuccess = () => tx.objectStore('meta').put({ ...r.result, writeFence: { operationId: crypto.randomUUID(), kind: 'delete' } }); tx.oncomplete = () => resolve(); }); db.close();
  }, generation);
  expect(await send('ExportBackup')).toMatchObject({ ok: false, code: 'LIBRARY_BUSY' });
  await library.evaluate(async generation => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(`akm-library-${generation}`); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => { const tx = db.transaction(['meta', 'captures'], 'readwrite'), r = tx.objectStore('meta').get('library'); r.onsuccess = () => tx.objectStore('meta').put({ ...r.result, writeFence: null }); tx.objectStore('captures').add({ id: crypto.randomUUID(), captureStatus: 'in_progress' }); tx.oncomplete = () => resolve(); }); db.close();
  }, generation);
  expect(await send('ExportBackup')).toMatchObject({ ok: false, code: 'CAPTURE_ACTIVE' });
  expect(await preview(before)).toMatchObject({ ok: false, code: 'CAPTURE_ACTIVE' });
});

test('export concurrent with another view editing yields one sequence and complete matching history', async () => {
  const saved = await create('Concurrent snapshot'), other = await context.newPage(); await other.goto(`chrome-extension://${extensionId}/library.html`);
  const [text, edited] = await Promise.all([
    exported(), other.evaluate(fields => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'SaveManualNote', ...fields }), { ...saved.fields, requestId: crypto.randomUUID(), noteId: saved.id, expectedRecordVersion: 1, fields: { ...saved.fields.fields, bodyMarkdown: 'Committed concurrently' } }),
  ]);
  expect(edited.ok).toBe(true); const backup = await validateBackup(JSON.parse(text));
  expect([1, 2]).toContain(backup.dataSeq); expect(backup.records.knowledgeRevisions.length).toBe(backup.records.knowledgeItems[0]!.currentVersion);
  expect(backup.records.knowledgeItems[0]!.bodyMarkdown).toBe(backup.dataSeq === 1 ? saved.fields.fields.bodyMarkdown : 'Committed concurrently');
});

test('chunk byte admission rejects understated UTF-8 and preserves a split surrogate pair', async () => {
  const begin = await send('BeginBackupUpload', { bytes: 1 });
  expect(await send('UploadBackupChunk', { transferId: begin.backup.transferId, index: 0, text: '中' })).toMatchObject({ ok: false, code: 'BACKUP_INVALID' });
  await create('Split 🧠 text'); const text = await exported(), index = text.indexOf('🧠') + 1;
  const upload = await send('BeginBackupUpload', { bytes: Buffer.byteLength(text) });
  expect((await send('UploadBackupChunk', { transferId: upload.backup.transferId, index: 0, text: text.slice(0, index) })).ok).toBe(true);
  expect((await send('UploadBackupChunk', { transferId: upload.backup.transferId, index: 1, text: text.slice(index) })).ok).toBe(true);
  expect((await send('PreviewRestore', { transferId: upload.backup.transferId })).ok).toBe(true); expect((await send('CancelRestore')).ok).toBe(true);
});
