import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import type { KnowledgeItem, KnowledgeRevision, LibraryMeta, RequestReceipt, SaveManualNote } from '../../src/shared/knowledge';
import type { Capture, Conversation, MessageRevision, SourceRef } from '../../src/shared/archive';
import type { DeleteTarget } from '../../src/shared/management';

let context: BrowserContext, library: Page, page: Page, sw: Worker, profile: string, extensionId: string, generation: string;
type State = { knowledgeItems: KnowledgeItem[]; knowledgeRevisions: KnowledgeRevision[]; sourceRefs: SourceRef[]; captures: Capture[]; conversations: Conversation[]; messageRevisions: MessageRevision[]; meta: LibraryMeta[]; requestReceipts: RequestReceipt[] };
async function launch() {
  const extension = resolve('.cache/authorized-extension');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(sw.url()).host;
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-synthetic.html' }));
  library = await context.newPage(); await library.goto(`chrome-extension://${extensionId}/library.html`);
  await expect(library.getByText('Local library ready.', { exact: true })).toBeVisible();
  generation = (await send({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).library.generation;
}
test.beforeEach(async () => {
  await mkdir('.cache/profiles', { recursive: true }); profile = await mkdtemp(resolve('.cache/profiles/a5-')); await launch();
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await library.getByRole('button', { name: 'Enable ChatGPT' }).click();
  await library.getByRole('link', { name: 'Knowledge', exact: true }).click();
  page = await context.newPage(); await page.goto('https://chatgpt.com/c/synthetic-a0'); await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
});
test.afterEach(async () => {
  await context?.close(); const child = relative(resolve('.cache/profiles'), resolve(profile));
  if (!child.startsWith('a5-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe profile cleanup');
  await rm(resolve(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function send(command: unknown, target = library) { return target.evaluate(command => chrome.runtime.sendMessage(command), command); }
async function state(): Promise<State> {
  return library.evaluate(async () => {
    const pointer = (await chrome.storage.local.get('activeLibrary')).activeLibrary as { generation: string };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(`akm-library-${pointer.generation}`); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const names = Array.from(db.objectStoreNames), tx = db.transaction(names, 'readonly');
      return Object.fromEntries(await Promise.all(names.map(name => new Promise<[string, unknown[]]>((resolve, reject) => { const r = tx.objectStore(name).getAll(); r.onsuccess = () => resolve([name, r.result]); r.onerror = () => reject(r.error); })))) as State;
    } finally { db.close(); }
  });
}
function intent() { return { protocolVersion: 1, generation, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString() }; }
async function create(title = 'Manual companion', body = 'Independent content') {
  const command: SaveManualNote = { ...intent(), protocolVersion: 1, type: 'SaveManualNote', noteId: null, expectedRecordVersion: null,
    fields: { title, bodyMarkdown: body, type: 'personal_note', tags: [], personalExplanation: '', applicableVersion: '', reviewAfter: null } };
  const reply = await send(command); expect(reply.ok).toBe(true); return { command, id: reply.result.knowledgeId as string };
}
async function keep() {
  await page.locator('#answer-text').evaluate(node => { const r = document.createRange(); r.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
  await page.getByRole('button', { name: 'Keep selection', exact: true }).click(); await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  return (await state()).knowledgeItems.find(n => n.origin === 'manual_selection')!;
}
async function capture() {
  await page.getByRole('button', { name: 'Save loaded conversation', exact: true }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click();
  await expect(page.getByText(/Saved 3 loaded messages/)).toBeVisible();
}
async function action(id: string, fields: Record<string, unknown>) {
  const n = (await state()).knowledgeItems.find(n => n.id === id)!;
  return send({ ...intent(), noteId: id, expectedRecordVersion: n.recordVersion, ...fields });
}
async function preview(target: DeleteTarget) { const reply = await send({ protocolVersion: 1, type: 'PreviewDeletion', generation, target }); expect(reply.ok).toBe(true); return reply.preview; }
async function remove(target: DeleteTarget) {
  const p = await preview(target), command = { ...intent(), type: 'DeleteLibraryData', expectedDataSeq: p.dataSeq, target };
  const reply = await send(command); expect(reply.ok).toBe(true); await expect(library.getByText('Local library ready.', { exact: true })).toBeVisible(); return command;
}

test('captured note edits preserve endorsement and exact sources; sources and duplicate provenance round-trip through history', async () => {
  const note = await keep(), original = (await state()).sourceRefs[0]!;
  expect((await action(note.id, { type: 'ReviewNote', state: 'endorsed', supersededById: null })).ok).toBe(true);
  await library.goto(`chrome-extension://${extensionId}/library.html?note=${note.id}`);
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByText('Metadata and editing tools', { exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('My edited procedure'); await library.getByLabel('Personal explanation').fill('Because it works');
  await library.getByRole('button', { name: 'Save note', exact: true }).click(); await expect(library.getByText('Saved to Knowledge · version 3.')).toBeVisible();
  let data = await state(); expect(data.knowledgeItems[0]).toMatchObject({ reviewState: 'endorsed', origin: 'manual_selection', bodyMarkdown: 'My edited procedure', personalExplanation: 'Because it works' });
  expect(data.sourceRefs[0]).toEqual(original); expect(data.knowledgeRevisions.find(r => r.version === 3)!.sources).toEqual([original]);
  await capture(); data = await state(); const c = data.captures.find(c => c.scope === 'loaded_conversation')!;
  const r = data.messageRevisions.find(r => r.id === c.revisionIds[0])!;
  expect((await action(note.id, { type: 'AddNoteSource', source: { kind: 'archive', captureId: c.id, revisionId: r.id, quote: r.plainText } })).ok).toBe(true);
  data = await state(); expect(data.sourceRefs).toHaveLength(2); expect(data.knowledgeRevisions.find(r => r.version === 3)!.sources).toHaveLength(1); expect(data.knowledgeRevisions.find(r => r.version === 4)!.sources).toHaveLength(2);
  const duplicate = await action(note.id, { type: 'DuplicateNote' }); expect(duplicate.ok).toBe(true);
  data = await state(); expect(data.knowledgeItems).toHaveLength(2); expect(data.sourceRefs).toHaveLength(4);
  expect(data.knowledgeItems.find(n => n.id === duplicate.result.knowledgeId)).toMatchObject({ curationKey: null, reviewState: 'saved', bodyMarkdown: 'My edited procedure' });
  await context.close(); await launch(); expect((await state()).knowledgeRevisions).toEqual(data.knowledgeRevisions);
});

test('supersession rejects cycles, outdated and excluded notes are recoverable, deleting replacement marks needs review', async () => {
  const a = await create('Older answer', 'TOKEN-OLD'), b = await create('New answer', 'TOKEN-NEW');
  expect((await action(a.id, { type: 'ReviewNote', state: 'superseded', supersededById: a.id })).code).toBe('SUPERSESSION_CYCLE');
  expect((await action(a.id, { type: 'ReviewNote', state: 'superseded', supersededById: b.id })).ok).toBe(true);
  expect((await action(b.id, { type: 'ReviewNote', state: 'superseded', supersededById: a.id })).code).toBe('SUPERSESSION_CYCLE');
  await library.getByLabel('Search saved Knowledge').fill('TOKEN-OLD'); await expect(library.getByText('No matching Knowledge. Try fewer terms or broaden the search.')).toBeVisible();
  await library.getByText('Filter Knowledge', { exact: true }).click(); await library.getByLabel('Include outdated (superseded)').check();
  await expect(library.getByRole('button', { name: 'Recall Older answer' })).toBeVisible();
  expect((await action(a.id, { type: 'ExcludeNote', excluded: true })).ok).toBe(true);
  await expect(library.getByRole('button', { name: 'Recall Older answer' })).toHaveCount(0); await library.getByLabel('Include excluded notes').check();
  await expect(library.getByRole('button', { name: 'Recall Older answer' })).toBeVisible();
  const p = await preview({ kind: 'note', noteId: b.id }); expect(p.supersessionLinks).toBe(1);
  await remove({ kind: 'note', noteId: b.id });
  const data = await state(); expect(data.knowledgeItems[0]).toMatchObject({ id: a.id, reviewState: 'needs_review', reviewedAt: null, supersededById: null });
  expect(data.knowledgeRevisions.some(r => r.changeReason === 'replacement_removed')).toBe(true);
  expect(await send(b.command)).toMatchObject({ ok: false, code: 'RESULT_REMOVED' });
});

test('note deletion preserves shared evidence and independent Archive; exclusive note/history copies are removed', async () => {
  const note = await keep(), second = await create();
  const source = (await state()).sourceRefs[0]!;
  await action(second.id, { type: 'AddNoteSource', source: { kind: 'existing', sourceId: source.id } });
  await remove({ kind: 'note', noteId: note.id });
  let data = await state(); expect(data.knowledgeItems).toHaveLength(1); expect(data.captures).toHaveLength(1); expect(data.sourceRefs).toHaveLength(1);
  expect(data.knowledgeRevisions.every(r => r.knowledgeId === second.id)).toBe(true);
  await capture(); await remove({ kind: 'note', noteId: second.id });
  data = await state(); expect(data.knowledgeItems).toHaveLength(0); expect(data.knowledgeRevisions).toHaveLength(0); expect(data.sourceRefs).toHaveLength(0);
  expect(data.captures.some(c => c.scope === 'loaded_conversation')).toBe(true); expect(data.messageRevisions.length).toBeGreaterThanOrEqual(3);
});

test('delete conversation keeps explicitly retained excerpts and detaches current and historical source references', async () => {
  const note = await keep(); await action(note.id, { type: 'ReviewNote', state: 'endorsed', supersededById: null }); await capture();
  const before = await state(), conversationId = before.conversations[0]!.id;
  const p = await preview({ kind: 'conversation', conversationId, mode: 'keep_knowledge' }); expect(p.counts.notes).toBe(0); expect(p.detachedSources).toBe(1);
  const command = await remove({ kind: 'conversation', conversationId, mode: 'keep_knowledge' });
  expect((await send(command)).result.deduplicated).toBe(true);
  const data = await state(); expect(data.captures).toHaveLength(0); expect(data.messageRevisions).toHaveLength(0); expect(data.conversations).toHaveLength(0);
  expect(data.knowledgeItems[0]).toMatchObject({ id: note.id, reviewState: 'endorsed', bodyMarkdown: note.bodyMarkdown });
  expect(data.sourceRefs[0]).toMatchObject({ exactText: before.sourceRefs[0]!.exactText, conversationId: null, captureId: null, revisionId: null }); expect(data.sourceRefs[0]!.sourceRemovedAt).toBeTruthy();
  expect(data.knowledgeRevisions.every(r => r.sources?.every(s => s.conversationId === null && !!s.sourceRemovedAt))).toBe(true);
  await library.goto(`chrome-extension://${extensionId}/library.html?note=${note.id}`);
  await library.locator('summary').filter({ hasText: /^Sources \(/ }).click();
  await expect(library.getByText(/Archive source removed on/)).toBeVisible();
});

test('cascade preview includes notes with other sources and stale previews cannot delete changed dependencies', async () => {
  const note = await keep(), other = await create('Multiple sources');
  let data = await state(); await action(other.id, { type: 'AddNoteSource', source: { kind: 'existing', sourceId: data.sourceRefs[0]!.id } });
  await capture(); data = await state(); const c = data.captures.find(c => c.scope === 'loaded_conversation')!, r = data.messageRevisions.find(r => r.id === c.revisionIds[0])!;
  await action(other.id, { type: 'AddNoteSource', source: { kind: 'archive', captureId: c.id, revisionId: r.id, quote: r.plainText } });
  const target: DeleteTarget = { kind: 'conversation', conversationId: data.conversations[0]!.id, mode: 'with_knowledge' }, p = await preview(target);
  expect(p.notes.find((n: { id: string }) => n.id === other.id).sources).toBe(2); expect(p.counts.notes).toBe(2);
  await action(note.id, { type: 'ReviewNote', state: 'needs_review', supersededById: null });
  expect(await send({ ...intent(), type: 'DeleteLibraryData', target, expectedDataSeq: p.dataSeq })).toMatchObject({ ok: false, code: 'PREVIEW_CHANGED' });
  expect((await state()).knowledgeItems).toHaveLength(2);
  await remove(target); data = await state();
  expect(data.knowledgeItems).toHaveLength(0); expect(data.knowledgeRevisions).toHaveLength(0); expect(data.sourceRefs).toHaveLength(0); expect(data.messageRevisions).toHaveLength(0);
});

test('confirmed UI deletion clears two open views, exact history and search workers before removal', async () => {
  const { id } = await create('Remove everywhere', 'DELETE-ME-456');
  const second = await context.newPage(); await second.goto(`chrome-extension://${extensionId}/library.html?note=${id}`);
  await second.getByLabel('Search saved Knowledge').fill('DELETE-ME-456'); await expect(second.getByRole('button', { name: 'Recall Remove everywhere' })).toBeVisible();
  await library.goto(`chrome-extension://${extensionId}/library.html?note=${id}`);
  await library.getByText('Review and other actions', { exact: true }).click();
  await library.getByRole('button', { name: 'Remove this note permanently' }).click();
  await expect(library.getByRole('region', { name: 'Deletion preview' })).toContainText('1 notes, 1 note revisions');
  await library.setViewportSize({ width: 360, height: 800 });
  expect(await library.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await library.screenshot({ path: 'artifacts/a5-deletion-preview-360.png', fullPage: true });
  await library.getByRole('button', { name: 'Confirm permanent deletion' }).click();
  await expect(library.getByText(/Deletion completed/)).toBeVisible(); await expect(second.getByLabel('Body (Markdown)')).toHaveValue('');
  expect(await second.locator('body').textContent()).not.toContain('DELETE-ME-456'); expect((await state()).knowledgeItems).toHaveLength(0);
});

test('Archive quote addition uses named note choices and retains its successful confirmation', async () => {
  const destination = await create('Destination note'); await capture();
  const captured = (await state()).captures[0]!;
  await library.goto(`chrome-extension://${extensionId}/library.html?capture=${captured.id}`);
  const message = library.getByRole('article', { name: 'Archive capture detail' }).locator('li[data-revision-id]').first();
  await message.getByText('Add this source to Knowledge', { exact: true }).click();
  await message.getByLabel('Destination note', { exact: true }).selectOption(destination.id);
  await message.getByRole('button', { name: 'Append source quote' }).click();
  await expect(message.getByText('Source appended. The note body and earlier provenance are unchanged.')).toBeVisible();
  expect((await state()).sourceRefs).toHaveLength(1);
});

test('Delete all removes generations, caches and settings; capture stays off and old writes cannot return', async () => {
  const saved = await create(); await keep(); await capture();
  await library.evaluate(async () => {
    await new Promise<void>((resolve, reject) => { const r = indexedDB.open('akm-library-staging-test'); r.onupgradeneeded = () => r.result.createObjectStore('staged'); r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error); });
    await caches.open('synthetic-derived-cache'); await chrome.storage.local.set({ obsoleteSetting: 'synthetic' });
  });
  const old = generation, command = await remove({ kind: 'all' });
  const data = await state(); expect(data.knowledgeItems).toHaveLength(0); expect(data.captures).toHaveLength(0); expect(data.requestReceipts).toHaveLength(0);
  expect(await send(saved.command)).toMatchObject({ ok: false, code: 'GENERATION_CHANGED' }); expect((await send(command)).result.deduplicated).toBe(true);
  const runtime = await library.evaluate(async () => ({ databases: (await indexedDB.databases()).map(d => d.name), caches: await caches.keys(), settings: await chrome.storage.local.get(null) }));
  expect(runtime.databases).not.toContain(`akm-library-${old}`); expect(runtime.databases).not.toContain('akm-library-staging-test'); expect(runtime.caches).toEqual([]); expect(runtime.settings).not.toHaveProperty('obsoleteSetting');
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(library.getByText('ChatGPT: Disabled')).toBeVisible(); await expect(page.locator('#akm-a0-probe')).toHaveCount(0);
  generation = (await send({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).library.generation; expect(generation).not.toBe(old);
});

test('reviewed fragments replace secrets before the first retained copy', async () => {
  await page.locator('#answer-text').evaluate(node => { node.textContent = 'Use SECRET-ABC-123 then retry.'; const r = document.createRange(); r.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
  await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
  await page.getByRole('button', { name: 'Review or replace before keeping' }).click();
  const editor = page.getByLabel('Fragment 1 before saving');
  await editor.evaluate((node: HTMLTextAreaElement) => { node.setSelectionRange(4, 18); });
  await page.getByRole('button', { name: 'Replace selected text in fragment 1' }).click();
  await expect(editor).toHaveValue('Use [API_KEY] then retry.');
  await page.getByRole('button', { name: 'Save reviewed fragments' }).click(); await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  const data = await state(); expect(JSON.stringify(data)).not.toContain('SECRET-ABC-123'); expect(data.sourceRefs[0]!.originalPageAnchor).toBeNull();
  expect(data.sourceRefs[0]!.exactText).toBe('Use [API_KEY] then retry.'); expect(data.knowledgeItems[0]!.bodyMarkdown).toBe(data.sourceRefs[0]!.exactText);
});

test('page callers cannot edit, add sources, preview or delete library content', async () => {
  const { id } = await create();
  const replies = await sw.evaluate(async ({ generation, id }) => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const r = await chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] }, args: [{ generation, id }], func: ({ generation, id }) => Promise.all([
      chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ReviewNote', generation, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId: id, expectedRecordVersion: 1, state: 'endorsed', supersededById: null }),
      chrome.runtime.sendMessage({ protocolVersion: 1, type: 'PreviewDeletion', generation, target: { kind: 'all' } }),
    ]) }); return r[0]!.result;
  }, { generation, id });
  expect(replies).toEqual([expect.objectContaining({ ok: false, code: 'UNAUTHORIZED_CONTEXT' }), expect.objectContaining({ ok: false, code: 'UNAUTHORIZED_CONTEXT' })]);
});

test('fragment exclusion removes the unchecked message before any retained copy', async () => {
  await page.evaluate(() => {
    const start = document.querySelector('#user-text')!, end = document.querySelector('#answer-text')!;
    start.textContent = 'EXCLUDE-PRIVATE-123';
    const range = document.createRange(); range.setStartBefore(start); range.setEndAfter(end);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
  await page.getByRole('button', { name: 'Review or replace before keeping' }).click();
  await page.getByLabel('Include fragment 1', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save reviewed fragments' }).click();
  await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  const data = await state(); expect(JSON.stringify(data)).not.toContain('EXCLUDE-PRIVATE-123');
  expect(data.sourceRefs).toHaveLength(1); expect(data.sourceRefs[0]!.sourceRole).toBe('assistant');
});

test('provider and date cleanup previews only eligible conversations and retains Knowledge excerpts', async () => {
  await keep(); await capture();
  expect((await preview({ kind: 'archive_filter', provider: 'gemini', through: '9999-12-31' })).conversations).toHaveLength(0);
  expect((await preview({ kind: 'archive_filter', provider: 'chatgpt', through: '2000-01-01' })).conversations).toHaveLength(0);
  const target: DeleteTarget = { kind: 'archive_filter', provider: 'chatgpt', through: '9999-12-31' };
  const scope = await preview(target); expect(scope.conversations).toHaveLength(1); expect(scope.counts.notes).toBe(0); expect(scope.detachedSources).toBe(1);
  await remove(target); const data = await state(); expect(data.conversations).toHaveLength(0);
  expect(data.knowledgeItems).toHaveLength(1); expect(data.sourceRefs[0]!.sourceRemovedAt).toBeTruthy();
});

for (const phase of ['before-commit', 'after-commit'] as const) {
  test(`interrupted large deletion ${phase} keeps the library fenced and resumes without resurrecting history`, async () => {
    test.setTimeout(60000);
    const saved = await create('Many revisions', 'ERASE-ME');
    await library.evaluate(async ({ generation, id }) => {
      const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(`akm-library-${generation}`); r.onsuccess = () => resolve(r.result); });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['knowledgeItems', 'knowledgeRevisions', 'meta'], 'readwrite'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
          const get = tx.objectStore('knowledgeItems').get(id);
          get.onsuccess = () => {
            const note = get.result as KnowledgeItem;
            for (let version = 2; version <= 600; version++) tx.objectStore('knowledgeRevisions').add({ id: crypto.randomUUID(), schemaVersion: 1, knowledgeId: id, version,
              changedAt: note.createdAt, changeReason: 'edited', snapshot: { ...note, recordVersion: version, currentVersion: version, bodyMarkdown: `ERASE-OLD-${version}` } });
            tx.objectStore('knowledgeItems').put({ ...note, recordVersion: 600, currentVersion: 600 });
          };
          const meta = tx.objectStore('meta').get('library'); meta.onsuccess = () => tx.objectStore('meta').put({ ...meta.result, dataSeq: meta.result.dataSeq + 1 });
        });
      } finally { db.close(); }
    }, { generation, id: saved.id });
    const target: DeleteTarget = { kind: 'note', noteId: saved.id }, p = await preview(target); expect(p.counts.histories).toBe(600);
    const command = { ...intent(), type: 'DeleteLibraryData', target, expectedDataSeq: p.dataSeq };
    const cdp = await context.newCDPSession(library); let versionId = '';
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => { const v = versions.find((v: { scriptURL: string; runningStatus: string }) => v.scriptURL === sw.url() && v.runningStatus === 'running'); if (v) versionId = v.versionId; });
    await cdp.send('ServiceWorker.enable'); await expect.poll(() => versionId).not.toBe('');
    await sw.evaluate(phase => {
      const flags = globalThis as typeof globalThis & { deletionPhase?: string }; let scheduled = false;
      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (...args: Parameters<IDBObjectStore['delete']>) {
        const result = remove.apply(this, args);
        if (this.name === 'knowledgeRevisions') {
          scheduled = true;
          if (phase === 'before-commit') { flags.deletionPhase = phase; const store = this; const pump = () => { store.get('test-only').onsuccess = pump; }; pump(); }
        }
        return result;
      };
      if (phase === 'after-commit') {
        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
          descriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
            if (scheduled && this.mode === 'readwrite' && this.objectStoreNames.contains('knowledgeRevisions')) { flags.deletionPhase = phase; return; }
            callback?.call(this, event);
          });
        } });
      }
    }, phase);
    const deletion = send(command).catch(() => undefined);
    await expect.poll(() => sw.evaluate(() => (globalThis as typeof globalThis & { deletionPhase?: string }).deletionPhase)).toBe(phase);
    await expect(library.getByLabel('Body (Markdown)')).toHaveCount(0); await expect(library.getByLabel('Search saved Knowledge')).toHaveCount(0);
    await cdp.send('ServiceWorker.stopWorker', { versionId }); await cdp.detach(); await deletion;
    await expect(library.getByText('Local library ready.', { exact: true })).toBeVisible({ timeout: 20000 });
    const data = await state(); expect(data.knowledgeItems).toHaveLength(0); expect(data.knowledgeRevisions).toHaveLength(0); expect(data.meta[0]!.writeFence).toBeNull(); expect(data.meta[0]).not.toHaveProperty('deletion');
    expect((await send(command)).result.deduplicated).toBe(true); expect(await send(saved.command)).toMatchObject({ ok: false, code: 'RESULT_REMOVED' });
  });
}

test('reset resumes from its persisted journal after a settings acknowledgement failure', async () => {
  await create(); const target: DeleteTarget = { kind: 'all' }, p = await preview(target);
  await sw.evaluate(() => {
    const remove = chrome.storage.local.remove.bind(chrome.storage.local); let once = true;
    chrome.storage.local.remove = async keys => { await remove(keys); if (once) { once = false; throw new Error('Synthetic reset acknowledgement loss'); } };
  });
  const command = { ...intent(), type: 'DeleteLibraryData', target, expectedDataSeq: p.dataSeq };
  expect((await send(command)).ok).toBe(false);
  await expect(library.getByLabel('Body (Markdown)')).toHaveCount(0);
  expect(await send({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).toMatchObject({ ok: false, code: 'LIBRARY_BUSY' });
  await library.getByRole('button', { name: 'Resume interrupted deletion' }).click();
  await expect(library.getByText('Local library ready.', { exact: true })).toBeVisible(); expect((await state()).knowledgeItems).toHaveLength(0);
  expect((await send(command)).result.deduplicated).toBe(true);
});
