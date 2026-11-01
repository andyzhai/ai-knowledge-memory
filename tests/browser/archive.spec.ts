import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import type { Capture, Message, MessageRevision, SourceRef } from '../../src/shared/archive';
import type { KnowledgeItem, LibraryMeta } from '../../src/shared/knowledge';
import type { CaptureCommand } from '../../src/shared/loaded-capture';

let context: BrowserContext, library: Page, page: Page, sw: Worker, profile: string, extensionId: string;
type Wire = typeof globalThis & { archiveCommands: CaptureCommand[] };
type State = { captures: Capture[]; messages: Message[]; messageRevisions: MessageRevision[]; knowledgeItems: KnowledgeItem[]; sourceRefs: SourceRef[]; meta: LibraryMeta[] };
async function launch() {
  const path = resolve('.cache/authorized-extension');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`] });
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(sw.url()).host;
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-synthetic.html' }));
  library = await context.newPage(); await library.goto(`chrome-extension://${extensionId}/library.html`);
  await expect(library.getByText('Local library ready.', { exact: true })).toBeVisible();
}
test.beforeEach(async () => {
  await mkdir('.cache/profiles', { recursive: true }); profile = await mkdtemp(resolve('.cache/profiles/a4-')); await launch();
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await library.getByRole('button', { name: 'Enable ChatGPT' }).click();
  await library.getByRole('link', { name: 'Knowledge', exact: true }).click();
  page = await context.newPage(); await page.goto('https://chatgpt.com/c/synthetic-a0'); await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
});
test.afterEach(async () => {
  await context?.close(); const child = relative(resolve('.cache/profiles'), resolve(profile));
  if (!child.startsWith('a4-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe profile cleanup');
  await rm(resolve(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function state(): Promise<State> {
  return library.evaluate(async () => {
    const { activeLibrary } = await chrome.storage.local.get('activeLibrary') as { activeLibrary: { generation: string } };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(`akm-library-${activeLibrary.generation}`); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { const names = Array.from(db.objectStoreNames), tx = db.transaction(names, 'readonly'); return Object.fromEntries(await Promise.all(names.map(name => new Promise<[string, unknown[]]>((resolve, reject) => { const r = tx.objectStore(name).getAll(); r.onsuccess = () => resolve([name, r.result]); r.onerror = () => reject(r.error); })))) as State; }
    finally { db.close(); }
  });
}
async function hook(drop: string | null = null, before = false) {
  await sw.evaluate(async ({ drop, before }) => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    await chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] }, args: [{ drop, before }], func: ({ drop, before }) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime); let once = !!drop;
      (globalThis as Wire).archiveCommands = [];
      (chrome.runtime as unknown as { sendMessage: (c: CaptureCommand) => Promise<unknown> }).sendMessage = async command => {
        if ('type' in command && /Archive|Loaded/.test(command.type)) (globalThis as Wire).archiveCommands.push(structuredClone(command));
        if (command.type === drop && once && before) { once = false; throw new Error('Synthetic pre-send disconnect'); }
        const reply = await send(command);
        if (command.type === drop && once) { once = false; throw new Error('Synthetic acknowledgement loss'); }
        return reply;
      };
    } });
  }, { drop, before });
}
async function replay(type: string, mutation: 'none' | 'hash' | 'skip' | 'generation' | 'owner' = 'none') {
  return sw.evaluate(async ({ type, mutation }) => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const results = await chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] }, args: [{ type, mutation }], func: async ({ type, mutation }) => {
      const commands = (globalThis as Wire).archiveCommands;
      const command = structuredClone(commands.find(c => c.type === type) ?? { ...commands.find(c => c.type === 'StartArchiveCapture'), type }) as CaptureCommand;
      if (mutation === 'hash' && command.type === 'ArchiveCaptureBatch') command.messages[0]!.blocks[0]!.text += ' changed';
      if (mutation === 'skip' && command.type === 'ArchiveCaptureBatch') command.number += 2;
      if (mutation === 'generation' && 'generation' in command) command.generation = crypto.randomUUID();
      if (mutation === 'owner') command.nonce = crypto.randomUUID();
      // Synthetic alternate terminal command has no Start-only fields.
      if (['FinishArchiveCapture', 'ArchiveCaptureStatus'].includes(command.type)) delete (command as unknown as { plan?: unknown }).plan;
      return chrome.runtime.sendMessage(command);
    } }); return results[0]!.result;
  }, { type, mutation });
}
async function capture() {
  await page.getByRole('button', { name: 'Save loaded conversation', exact: true }).click();
  await expect(page.getByText(/loaded messages on the observed branch/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm Archive capture' }).click();
  await expect(page.getByText(/Saved \d+ loaded messages to Archive/)).toBeVisible();
}
async function manyMessages() {
  await page.evaluate(() => { for (let i = 3; i < 23; i++) { const node = document.createElement('article'); node.setAttribute('data-message-author-role', 'assistant'); node.setAttribute('data-message-id', `a${i}`); const p = document.createElement('p'); p.textContent = `Loaded archive-token-${i}`; node.append(p); document.querySelector('main')!.append(node); } });
}
async function archiveSearch(query: string) {
  await library.getByRole('link', { name: 'Archive', exact: true }).click(); await library.getByRole('button', { name: 'Refresh Archive', exact: true }).click();
  await library.getByLabel('Search Archive', { exact: true }).fill(query); await expect(library.locator('[data-archive-phase="ready"]')).toBeVisible();
}

for (const route of ['/c/bubble-test', '/g/synthetic-project/c/bubble-test']) {
  test(`observed user bubbles retain ordered messages, search and recapture evidence on ${route}`, async () => {
    await context.route(`https://chatgpt.com${route}`, request => request.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-user-bubbles.html' }));
    await page.goto(`https://chatgpt.com${route}`);
    const code = await page.locator('#code-text').textContent();
    await capture();
    const initial = await state(), first = initial.captures[0]!;
    expect(first.revisionIds).toHaveLength(4);
    const ordered = first.revisionIds.map(id => initial.messageRevisions.find(r => r.id === id)!);
    expect(ordered.map(r => r.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(ordered[0]!.plainText).toBe('Explain ORACLE-QUESTION-731 🧠 中文.');
    expect(ordered[2]!.plainText).toBe('FOLLOWUP-QUESTION-953 请保留缩进。');
    expect(ordered[1]!.blocks.find(b => b.kind === 'code')!.text).toBe(code);
    expect(first.branchObservation!.messageIds).toEqual([null, 'answer-one', null, 'answer-two']);
    expect(first.warnings).toEqual(expect.arrayContaining(['ambiguous_identity_separate_observation', 'hidden_messages_omitted']));
    expect(JSON.stringify(initial)).not.toMatch(/SECRET|You said:|ChatGPT said:|Copy answer|Edit prompt/);
    for (const [query, role] of [['ORACLE-QUESTION-731', 'user'], ['ORACLE-ANSWER-842', 'assistant']]) {
      await archiveSearch(query!);
      await library.getByRole('button', { name: `Open ${role} source` }).click();
      const detail = library.getByRole('article', { name: 'Archive capture detail' });
      await expect(detail).toContainText('4 committed messages');
      await expect(detail.locator('.conversation-messages h4')).toHaveText(['You', 'Assistant', 'You', 'Assistant']);
      expect(await detail.locator('pre code').textContent()).toBe(code);
      await detail.getByRole('button', { name: 'Back to conversations' }).click();
    }
    // Pin an existing assistant revision before a deliberately incomplete capture.
    await page.getByRole('button', { name: 'Close capture' }).click();
    await page.locator('#answer-text').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
    await page.getByRole('button', { name: 'Keep selection', exact: true }).click();
    await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
    const pinned = (await state()).sourceRefs;
    await page.getByRole('button', { name: 'Close preview' }).click();
    await page.locator('#question-one,#question-two').evaluateAll(nodes => nodes.forEach(node => node.setAttribute('hidden', '')));
    await capture();
    const incomplete = (await state()).captures.find(c => c.id !== first.id && c.scope === 'loaded_conversation')!;
    expect(incomplete.revisionIds).toEqual([ordered[1]!.id, ordered[3]!.id]);
    await page.getByRole('button', { name: 'Close capture' }).click();
    await page.locator('#question-one,#question-two').evaluateAll(nodes => nodes.forEach(node => node.removeAttribute('hidden')));
    await page.locator('#answer-text').evaluate(node => { node.textContent = 'REVISED-ANSWER-275 新版本。'; });
    await capture();
    const after = await state();
    expect(after.captures.find(c => c.id === first.id)).toEqual(first);
    expect(after.captures.find(c => c.id === incomplete.id)).toEqual(incomplete);
    expect(after.sourceRefs).toEqual(pinned);
    for (const revision of initial.messageRevisions) expect(after.messageRevisions.find(r => r.id === revision.id)).toEqual(revision);
    const latest = after.captures.find(c => c.scope === 'loaded_conversation' && c.id !== first.id && c.id !== incomplete.id)!;
    expect(latest.revisionIds).toHaveLength(4);
    expect(latest.revisionIds[3]).toBe(ordered[3]!.id);
    expect(latest.revisionIds[1]).not.toBe(ordered[1]!.id);
    // No provider identity was observed on user bubbles: retain separate observations.
    expect(after.messages.filter(m => m.contentScope === 'message' && m.sourceMessageId === null)).toHaveLength(4);
    await archiveSearch('ORACLE-QUESTION-731');
    await expect(library.getByRole('button', { name: 'Open user source' })).toHaveCount(2);
  });
}

test('bubble fallback prefers explicit boundaries and reports unsupported or ambiguous conversation content', async () => {
  await context.route('https://chatgpt.com/c/bubble-test', request => request.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-user-bubbles.html' }));
  await page.goto('https://chatgpt.com/c/bubble-test');
  await page.locator('#question-one').evaluate(node => {
    node.parentElement!.setAttribute('data-message-author-role', 'user');
    node.parentElement!.setAttribute('data-message-id', 'legacy-user');
  });
  await page.locator('#question-two').evaluate(node => node.firstElementChild!.setAttribute('data-markdown-text-style', 'assistant-message'));
  await page.locator('[data-chatgpt-conversation-selection-target]').evaluate(node => {
    const unsupported = document.createElement('div'); unsupported.setAttribute('data-chatgpt-search-unit-key', 'unsupported-unit');
    unsupported.textContent = 'UNSUPPORTED-UNIT-SECRET'; node.append(unsupported);
  });
  await page.getByRole('button', { name: 'Save loaded conversation', exact: true }).click();
  await expect(page.getByText(/unsupported conversation units omitted/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm Archive capture' }).click();
  await expect(page.getByText(/Saved 4 loaded messages to Archive/)).toBeVisible();
  const data = await state(), capture = data.captures[0]!;
  expect(capture.revisionIds.map(id => data.messageRevisions.find(r => r.id === id)!.role)).toEqual(['user', 'assistant', 'unknown', 'assistant']);
  expect(capture.branchObservation!.messageIds).toEqual(['legacy-user', 'answer-one', null, 'answer-two']);
  expect(capture.warnings).toEqual(expect.arrayContaining(['role_unknown', 'unsupported_conversation_units_omitted']));
  expect(JSON.stringify(data)).not.toContain('UNSUPPORTED-UNIT-SECRET');
});

test('loaded capture preserves ordered roles, exact code and exclusions; Archive only survives browser restart', async () => {
  const code = await page.locator('#code-text').textContent(); await capture();
  const data = await state(); expect(data.knowledgeItems).toHaveLength(0); expect(data.captures).toHaveLength(1);
  const c = data.captures[0]!; expect(c).toMatchObject({ captureStatus: 'completed', historyCoverage: 'loaded_only', branchCoverage: 'visible_branch', scope: 'loaded_conversation' });
  const ordered = c.revisionIds.map(id => data.messageRevisions.find(r => r.id === id)!);
  expect(ordered.map(r => r.role)).toEqual(['user', 'assistant', 'assistant']);
  expect(ordered[1]!.blocks.find(b => b.kind === 'code')!.text).toBe(code);
  expect(ordered[1]!.blocks.filter(b => b.kind === 'paragraph').map(b => b.text)).toEqual(['Start 🧠 中文 then retry.', 'Repeated quote.', 'Repeated quote.']);
  expect(JSON.stringify(data)).not.toMatch(/Private unsent prompt|Copy control|Hidden duplicate answer|Sidebar content/);
  await context.close(); await launch(); await context.setOffline(true); await archiveSearch('HT-928');
  await expect(library.getByRole('list', { name: 'Archive search results' })).toContainText('assistant');
  await library.getByRole('button', { name: 'Open assistant source' }).first().click();
  await expect(library.getByRole('article', { name: 'Archive capture detail' })).toContainText(code!);
  await library.setViewportSize({ width: 360, height: 800 }); expect(await library.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await library.screenshot({ path: 'artifacts/a4-archive-360.png', fullPage: true });
});

test('Open Archive capture from the source page opens the saved local detail', async () => {
  await capture();
  const before = await state();
  const opened = context.waitForEvent('page');
  await page.getByText('Open Archive capture', { exact: true }).click();
  const detailPage = await opened;
  await expect(detailPage.getByRole('article', { name: 'Archive capture detail' })).toContainText('Explain HT-928');
  expect(detailPage.url()).toBe(`chrome-extension://${extensionId}/library.html?capture=${before.captures[0]!.id}`);
  expect((await state()).meta[0]!.dataSeq).toBe(before.meta[0]!.dataSeq);
});

test('an opening failure can be retried without resaving the capture', async () => {
  await capture(); await hook('OpenArchiveCapture', true);
  const before = await state();
  await page.getByRole('button', { name: 'Open Archive capture' }).click();
  await expect(page.getByText(/Could not open Archive: .* Your capture is saved/)).toBeVisible();
  await expect(page.getByText(/Saved 3 loaded messages to Archive/)).toBeVisible();
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open Archive capture' }).click();
  await expect((await opened).getByRole('article', { name: 'Archive capture detail' })).toContainText('Explain HT-928');
  const after = await state(); expect(after.captures).toHaveLength(1); expect(after.meta[0]!.dataSeq).toBe(before.meta[0]!.dataSeq);
});

test('opening a capture rejects another document, stale generation, navigation and arbitrary URLs', async () => {
  await capture();
  const captureId = (await state()).captures[0]!.id;
  const generation = await library.evaluate(async () => ((await chrome.storage.local.get('activeLibrary')).activeLibrary as { generation: string }).generation);
  const other = await context.newPage(); await other.goto('https://chatgpt.com/c/other');
  await expect(other.locator('#akm-a0-probe')).toHaveCount(1);
  const open = (url: string, fields = {}) => sw.evaluate(async ({ url, command }) => {
    const [tab] = await chrome.tabs.query({ url });
    const result = await chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] }, args: [command], func: command => chrome.runtime.sendMessage(command) });
    return result[0]!.result;
  }, { url, command: { protocolVersion: 1, type: 'OpenArchiveCapture', generation, captureId, ...fields } });
  const pages = context.pages().length;
  expect(await open(other.url())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_CONTEXT' });
  expect(await open(page.url(), { generation: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'GENERATION_CHANGED' });
  expect(await open(page.url(), { url: 'https://example.test/' })).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  expect(await open(page.url(), { captureId: '../library.html' })).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  await page.evaluate(() => history.pushState({}, '', '/c/changed'));
  const moved = await open(page.url());
  expect(moved.ok).toBe(false); expect(moved.code).toMatch(/^(UNAUTHORIZED_CONTEXT|NAVIGATION_CHANGED)$/);
  expect(context.pages()).toHaveLength(pages);
});

test('lost batch acknowledgement, ordered retries, conflicting hashes and finalization are durable', async () => {
  await manyMessages(); await hook('ArchiveCaptureBatch');
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click();
  await expect(page.getByText(/Capture not confirmed/)).toBeVisible();
  const initial = await state(); expect(initial.captures[0]!.revisionIds).toHaveLength(8); expect(initial.captures[0]!.captureStatus).toBe('in_progress');
  expect(await replay('ArchiveCaptureBatch')).toMatchObject({ ok: true, progress: { committedMessages: 8 } });
  expect(await replay('ArchiveCaptureBatch', 'hash')).toMatchObject({ ok: false, code: 'BATCH_REUSED' });
  expect(await replay('ArchiveCaptureBatch', 'skip')).toMatchObject({ ok: false, code: 'BATCH_OUT_OF_ORDER' });
  expect(await replay('FinishArchiveCapture')).toMatchObject({ ok: false, code: 'CAPTURE_INCOMPLETE' });
  expect(await replay('ArchiveCaptureBatch', 'generation')).toMatchObject({ ok: false, code: 'GENERATION_CHANGED' });
  expect(await replay('ArchiveCaptureBatch', 'owner')).toMatchObject({ ok: false, code: 'NAVIGATION_CHANGED' });
  await archiveSearch('HT-928'); await expect(library.getByText('No matching Archive messages.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry same capture' }).click(); await expect(page.getByText(/Saved 23 loaded messages/)).toBeVisible();
  const final = await state(); expect(final.captures[0]!.revisionIds).toHaveLength(23); expect(new Set(final.captures[0]!.revisionIds).size).toBe(23);
  // Successful coordinator releases its nonce; terminal status stays persisted.
  expect(final.captures[0]!.nextExpectedBatch).toBe(3); expect(final.knowledgeItems).toHaveLength(0);
  await archiveSearch('archive-token-22'); await library.getByRole('button', { name: 'Open assistant source' }).click();
  const detail = library.getByRole('article', { name: 'Archive capture detail' }); await expect(detail).toContainText('Loaded archive-token-22');
  await detail.getByRole('button', { name: 'Previous messages' }).click(); await expect(detail).toContainText('Loaded archive-token-8');
  await detail.getByRole('button', { name: 'Previous messages' }).click(); await expect(detail).toContainText('Explain HT-928');
  await expect(detail.getByRole('button', { name: 'Previous messages' })).toBeDisabled();
});

test('worker restart between batches resumes the valid page; lost final acknowledgement is idempotent', async () => {
  await manyMessages(); await hook('ArchiveCaptureBatch');
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click(); await expect(page.getByText(/Capture not confirmed/)).toBeVisible();
  const cdp = await context.newCDPSession(library); let versionId = '';
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => { const v = versions.find((v: { scriptURL: string; runningStatus: string }) => v.scriptURL === sw.url() && v.runningStatus === 'running'); if (v) versionId = v.versionId; });
  await cdp.send('ServiceWorker.enable'); await expect.poll(() => versionId).not.toBe(''); await cdp.send('ServiceWorker.stopWorker', { versionId }); await cdp.detach();
  await page.getByRole('button', { name: 'Retry same capture' }).click(); await expect(page.getByText(/Saved 23 loaded messages/)).toBeVisible();
  sw = context.serviceWorkers().find(worker => worker.url().includes(extensionId))!;
  await page.getByRole('button', { name: 'Close capture' }).click(); await hook('FinishArchiveCapture');
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click(); await expect(page.getByText(/Capture not confirmed/)).toBeVisible();
  const before = await state(); expect(before.captures.every(c => c.captureStatus === 'completed')).toBe(true);
  expect(await replay('FinishArchiveCapture')).toMatchObject({ ok: true, progress: { status: 'completed', committedMessages: 23 } });
  expect((await state()).meta[0]!.dataSeq).toBe(before.meta[0]!.dataSeq);
  await page.getByRole('button', { name: 'Retry same capture' }).click(); await expect(page.getByText(/Saved 23 loaded messages/)).toBeVisible();
});

test('navigation interrupts committed membership under the original identity and blocks stale continuation', async () => {
  await manyMessages(); await hook('ArchiveCaptureBatch');
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click(); await expect(page.getByText(/Capture not confirmed/)).toBeVisible();
  await page.evaluate(() => { history.pushState({}, '', '/c/other'); history.pushState({}, '', '/c/synthetic-a0'); });
  expect(await replay('ArchiveCaptureBatch')).toMatchObject({ ok: false, code: 'NAVIGATION_CHANGED' });
  await archiveSearch('HT-928'); await expect(library.getByRole('list', { name: 'Archive search results' })).toContainText('interrupted');
  const data = await state(); expect(data.captures[0]).toMatchObject({ captureStatus: 'interrupted' }); expect(data.captures[0]!.revisionIds).toHaveLength(8);
});

test('loaded capture survives ChatGPT sidebar SPA navigation from A to B', async () => {
  await page.evaluate(() => { history.pushState({}, '', '/c/synthetic-a1'); });
  await page.getByRole('button', { name: 'Save loaded conversation' }).click();
  await expect(page.getByText(/loaded messages on the observed branch/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm Archive capture' }).click();
  await expect(page.getByText(/Saved \d+ loaded messages to Archive/)).toBeVisible();
  const data = await state(); expect(data.captures).toHaveLength(1); expect(data.captures[0]!.captureStatus).toBe('completed');
});

test('edits, known variants, repeated unknown messages, excerpts and partial later branches retain prior revisions', async () => {
  await capture(); const first = (await state()).captures[0]!;
  await page.getByRole('button', { name: 'Close capture' }).click();
  await page.locator('#answer-text').evaluate(node => { node.textContent = 'New answer RECENT-555'; });
  await page.locator('[data-message-id="a2"]').evaluate(node => node.remove());
  await capture();
  let data = await state(); expect(data.messages).toHaveLength(3); expect(data.messageRevisions).toHaveLength(4);
  expect(first.revisionIds.every(id => data.messageRevisions.some(r => r.id === id))).toBe(true);
  await archiveSearch('"Start 🧠 中文"'); await expect(library.getByText('No matching Archive messages.')).toBeVisible();
  await library.getByText('Filter Archive', { exact: true }).click();
  await library.getByLabel('Include previous versions').check(); await expect(library.getByRole('list', { name: 'Archive search results' })).toContainText('previous version');
  await library.getByRole('button', { name: 'Open assistant source' }).click(); await expect(library.getByRole('article', { name: 'Archive capture detail' })).toContainText('Start 🧠 中文 then retry.');
  await archiveSearch('unfinished'); await expect(library.getByRole('list', { name: 'Archive search results' })).toContainText('An unfinished answer');
  await page.getByRole('button', { name: 'Close capture' }).click();
  await page.locator('#answer-text').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
  await page.getByRole('button', { name: 'Keep selection', exact: true }).click(); await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  await archiveSearch('unfinished'); await expect(library.getByRole('list', { name: 'Archive search results' })).toContainText('An unfinished answer');
  await page.getByRole('button', { name: 'Close preview' }).click();
  await page.locator('[data-message-id="a1"]').evaluate(node => node.setAttribute('data-message-id', 'known-variant'));
  await capture(); data = await state(); expect(data.messages.filter(m => m.contentScope === 'message')).toHaveLength(4);
  await page.getByRole('button', { name: 'Close capture' }).click();
  await page.locator('[data-message-id="known-variant"]').evaluate(node => { node.removeAttribute('data-message-id'); node.after(node.cloneNode(true)); });
  await capture(); data = await state(); expect(data.messages.filter(m => m.contentScope === 'message' && m.sourceMessageId === null)).toHaveLength(2);
});

test('streaming waits for affirmative completion; timeout explicitly offers partial or cancel; observations remain separate', async () => {
  test.setTimeout(45000);
  await page.locator('[data-message-id="a2"]').evaluate(node => node.setAttribute('data-is-streaming', 'true'));
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await expect(page.getByText(/Waiting up to 15 seconds/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save partial now' })).toBeVisible({ timeout: 18000 });
  expect((await state()).captures).toHaveLength(0);
  await page.getByRole('button', { name: 'Save partial now' }).click(); await expect(page.getByText(/Saved 3 loaded messages/)).toBeVisible();
  const before = await state(), partial = before.captures[0]!;
  await page.getByRole('button', { name: 'Close capture' }).click();
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await expect(page.getByText(/Waiting up to 15 seconds/)).toBeVisible();
  await page.locator('[data-message-author-role="assistant"]').evaluateAll(nodes => nodes.forEach(node => node.setAttribute('data-is-streaming', 'false')));
  await page.getByRole('button', { name: 'Confirm Archive capture' }).click(); await expect(page.getByText(/Saved 3 loaded messages/)).toBeVisible();
  const after = await state(); expect(after.messageRevisions).toHaveLength(before.messageRevisions.length);
  const complete = after.captures.find(c => c.id !== partial.id)!;
  expect(complete.revisionIds).toEqual(partial.revisionIds); expect(partial.membership[2]!.completion).toBe('partial'); expect(complete.membership[2]!.completion).toBe('complete');
});

test('media, tables, math, links and unknown role warn honestly; oversize content rejects without truncating', async () => {
  await page.evaluate(() => { const m = document.querySelector('[data-message-id="a2"]')!; m.setAttribute('data-message-author-role', 'unrecognized'); m.innerHTML = '<p>Visible <img alt="diagram"/> caption <a href="https://example.com/docs">docs</a></p><table><tr><th>A</th><td>B</td></tr></table><math>x = 2</math>'; });
  await capture(); const data = await state(), revision = data.messageRevisions.find(r => r.role === 'unknown')!;
  expect(revision.blocks).toContainEqual({ kind: 'table', rows: [['A', 'B']], text: 'A\tB' });
  expect(revision.blocks).toContainEqual({ kind: 'link', text: '', url: 'https://example.com/docs' });
  expect(data.captures[0]!.warnings).toEqual(expect.arrayContaining(['role_unknown', 'media_not_downloaded', 'table_layout_simplified', 'math_visible_text_only']));
  await page.getByRole('button', { name: 'Close capture' }).click(); await page.locator('#code-text').evaluate(node => { node.textContent = 'x'.repeat(300000); });
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await expect(page.getByText(/MESSAGE_TOO_LARGE/)).toBeVisible(); expect((await state()).captures).toHaveLength(1);
});

test('temporary gate, explicit cancellation, provider disable and read authority remain enforced', async () => {
  await page.evaluate(() => { const banner = document.createElement('div'); banner.setAttribute('data-testid', 'temporary-chat-banner'); banner.textContent = 'Temporary chat'; document.body.prepend(banner); });
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await expect(page.getByRole('button', { name: 'Allow saving this conversation' })).toBeVisible();
  expect((await state()).captures).toHaveLength(0); await page.getByRole('button', { name: 'Cancel capture' }).click(); expect((await state()).captures).toHaveLength(0);
  await page.getByRole('button', { name: 'Close capture' }).click(); await manyMessages(); await hook('ArchiveCaptureBatch');
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await page.getByRole('button', { name: 'Allow saving this conversation' }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click(); await expect(page.getByText(/Capture not confirmed/)).toBeVisible();
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await library.getByRole('button', { name: 'Disable ChatGPT and remove access' }).click(); await archiveSearch('HT-928');
  expect((await state()).captures[0]!.captureStatus).toBe('interrupted');
  await expect(page.getByRole('button', { name: 'Save loaded conversation' })).toHaveCount(0);
});

test('original source verification distinguishes unique, ambiguous, changed and missing without altering local evidence', async () => {
  await page.locator('#answer-text').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
  await page.getByRole('button', { name: 'Keep selection', exact: true }).click(); await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  const data = await state(); await library.goto(`chrome-extension://${extensionId}/library.html?note=${data.knowledgeItems[0]!.id}`);
  await library.locator('summary').filter({ hasText: /^Sources \(/ }).click();
  const check = library.getByRole('button', { name: 'Check original in open ChatGPT tab' });
  await check.click(); await expect(library.getByText(/Original source verified now/)).toBeVisible();
  await page.locator('#answer-text').evaluate(node => node.after(node.cloneNode(true))); await check.click(); await expect(library.getByText(/Original source ambiguous/)).toBeVisible();
  await page.locator('#answer-text').evaluateAll(nodes => nodes.forEach(node => { node.textContent = 'changed source'; })); await check.click(); await expect(library.getByText(/Source changed: the same message identity/)).toBeVisible();
  await page.locator('[data-message-id="a1"]').evaluate(node => node.remove()); await check.click(); await expect(library.getByText(/Original message is not loaded/)).toBeVisible();
  expect((await state()).sourceRefs).toEqual(data.sourceRefs);
});

for (const phase of ['before-commit', 'after-commit'] as const) {
  test(`worker termination ${phase} of a native batch transaction retains atomic progress and retries`, async () => {
    test.setTimeout(60000); await manyMessages();
    const cdp = await context.newCDPSession(library); let versionId = '';
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => { const v = versions.find((v: { scriptURL: string; runningStatus: string }) => v.scriptURL === sw.url() && v.runningStatus === 'running'); if (v) versionId = v.versionId; });
    await cdp.send('ServiceWorker.enable'); await expect.poll(() => versionId).not.toBe('');
    await sw.evaluate(phase => {
      const flags = globalThis as typeof globalThis & { archivePhase?: string }; let batchScheduled = false;
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
        const request = add.apply(this, args);
        if (this.name === 'messageRevisions') {
          batchScheduled = true;
          if (phase === 'before-commit') { flags.archivePhase = phase; const store = this; const pump = () => { store.get('test-only').onsuccess = pump; }; pump(); }
        }
        return request;
      };
      if (phase === 'after-commit') {
        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
          descriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
            if (batchScheduled && this.mode === 'readwrite' && this.objectStoreNames.contains('messageRevisions')) { flags.archivePhase = phase; return; }
            callback?.call(this, event);
          });
        } });
      }
    }, phase);
    await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click();
    await expect.poll(() => sw.evaluate(() => (globalThis as typeof globalThis & { archivePhase?: string }).archivePhase)).toBe(phase);
    await cdp.send('ServiceWorker.stopWorker', { versionId }); await cdp.detach();
    const stopped = await state(); expect(stopped.messageRevisions).toHaveLength(phase === 'before-commit' ? 0 : 8); expect(stopped.captures[0]!.revisionIds).toHaveLength(stopped.messageRevisions.length);
    expect(stopped.captures[0]!.captureStatus).toBe('in_progress');
    await expect(page.getByText(/Capture not confirmed/)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Retry same capture' }).click(); await expect(page.getByText(/Saved 23 loaded messages/)).toBeVisible();
    const final = await state(); expect(final.messageRevisions).toHaveLength(23); expect(final.captures[0]!.acceptedBatches).toHaveLength(3); expect(final.captures[0]!.captureStatus).toBe('completed');
  });
}

test('quota failure rolls back a batch; full browser restart exposes only committed orphaned membership', async () => {
  await manyMessages(); await sw.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) { if (this.name === 'messageRevisions') throw new DOMException('synthetic full disk', 'QuotaExceededError'); return add.apply(this, args); };
    (globalThis as typeof globalThis & { restoreArchive: () => void }).restoreArchive = () => { IDBObjectStore.prototype.add = add; };
  });
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click();
  await expect(page.getByText(/Capture not confirmed: STORAGE_FULL/)).toBeVisible(); let data = await state(); expect(data.messages).toHaveLength(0); expect(data.captures[0]!.acceptedBatches).toHaveLength(0);
  await sw.evaluate(() => (globalThis as typeof globalThis & { restoreArchive: () => void }).restoreArchive()); await hook('ArchiveCaptureBatch');
  await page.getByRole('button', { name: 'Retry same capture' }).click(); await expect(page.getByText(/Capture not confirmed: WRITE_UNCONFIRMED/)).toBeVisible(); expect((await state()).messages).toHaveLength(8);
  await context.close(); await launch(); await archiveSearch('HT-928'); data = await state(); expect(data.captures[0]!.captureStatus).toBe('interrupted'); expect(data.messages).toHaveLength(8);
  await expect(library.getByRole('list', { name: 'Archive search results' })).toContainText('interrupted');
});

test('selection reuses an unambiguous archived full revision and Undo preserves independently retained evidence', async () => {
  await capture(); const before = await state(); await page.getByRole('button', { name: 'Close capture' }).click();
  await page.locator('#answer-text').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
  await page.getByRole('button', { name: 'Keep selection', exact: true }).click(); await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  const saved = await state(); expect(saved.messageRevisions).toHaveLength(before.messageRevisions.length); expect(saved.sourceRefs[0]!.contentScope).toBe('message');
  expect(before.messageRevisions.map(r => r.id)).toContain(saved.sourceRefs[0]!.revisionId);
  await page.getByRole('button', { name: 'Undo new selection' }).click(); await expect(page.getByText(/Undone/)).toBeVisible();
  const undone = await state(); expect(undone.knowledgeItems).toHaveLength(0); expect(undone.messageRevisions).toEqual(saved.messageRevisions); expect(undone.captures.find(c => c.id === before.captures[0]!.id)).toEqual(before.captures[0]);
});

test('current response structure is supported conservatively; hidden duplicates and collapsed content are omitted', async () => {
  await context.route('https://chatgpt.com/c/current', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-current-structure.html' }));
  await page.goto('https://chatgpt.com/c/current');
  await page.locator('[data-chatgpt-selection-conversation-id]').evaluate(node => {
    node.setAttribute('data-chatgpt-selection-conversation-id', 'current'); const hidden = node.cloneNode(true) as Element; hidden.setAttribute('hidden', ''); node.after(hidden);
    const details = document.createElement('details'); details.innerHTML = '<summary>Collapsed attachment</summary><p>UNLOADED-SECRET</p>'; node.append(details);
  });
  await capture(); const data = await state(); expect(data.messages).toHaveLength(1); expect(data.messageRevisions[0]!.role).toBe('assistant');
  expect(data.captures[0]!.warnings).toEqual(expect.arrayContaining(['hidden_messages_omitted', 'collapsed_content_omitted']));
  expect(JSON.stringify(data)).not.toContain('UNLOADED-SECRET'); expect(data.messageRevisions[0]!.plainText).toContain('Collapsed attachment');
});

test('Archive reads reject page callers, unknown fields and stale canonical markers', async () => {
  const before = await library.evaluate(() => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetArchiveSearchState' })); await capture();
  expect(await library.evaluate(marker => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ReadArchiveSearchPage', marker, afterId: null }), before.marker)).toMatchObject({ ok: false, code: 'SEARCH_CHANGED' });
  expect(await library.evaluate(() => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetArchiveSearchState', unchecked: true }))).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  const results = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); return chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] }, func: () => Promise.all([
      chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetArchiveSearchState' }), chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ListArchiveCaptures', offset: 0, conversationId: null }),
    ]) });
  });
  expect(results[0]!.result).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, code: 'UNAUTHORIZED_CONTEXT' })]));
});

test('an in-progress recapture cannot advance visibility or change a pinned source revision', async () => {
  await capture(); await page.getByRole('button', { name: 'Close capture' }).click();
  await page.locator('#answer-text').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
  await page.getByRole('button', { name: 'Keep selection', exact: true }).click(); await expect(page.getByText('Saved to Knowledge. Saved does not mean endorsed.', { exact: true })).toBeVisible();
  const pinned = (await state()).sourceRefs[0]!; await page.getByRole('button', { name: 'Close preview' }).click();
  await manyMessages(); await page.locator('#answer-text').evaluate(node => { node.textContent = 'Replacement NEW-666'; }); await hook('ArchiveCaptureBatch');
  await page.getByRole('button', { name: 'Save loaded conversation' }).click(); await page.getByRole('button', { name: 'Confirm Archive capture' }).click(); await expect(page.getByText(/Capture not confirmed/)).toBeVisible();
  await archiveSearch('"Start 🧠 中文"'); await expect(library.getByRole('list', { name: 'Archive search results' })).toContainText('Start 🧠 中文');
  await archiveSearch('NEW-666'); await expect(library.getByText('No matching Archive messages.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry same capture' }).click(); await expect(page.getByText(/Saved 23 loaded messages/)).toBeVisible();
  await archiveSearch('NEW-666'); await expect(library.getByRole('list', { name: 'Archive search results' })).toContainText('Replacement NEW-666');
  await archiveSearch('"Start 🧠 中文"'); await expect(library.getByText('No matching Archive messages.')).toBeVisible();
  const final = await state(); expect(final.sourceRefs[0]).toEqual(pinned); expect(final.messageRevisions.find(r => r.id === pinned.revisionId)!.plainText).toContain('Start 🧠 中文');
});
