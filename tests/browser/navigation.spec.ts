import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

let context: BrowserContext, library: Page, profile: string, base: string, generation: string;
type Probe = { live: number; cleared: { workers: number; editors: number; details: number }[]; delayed: number };
type InstrumentedWindow = Window & typeof globalThis & { navigationProbe: Probe };
test.beforeEach(async () => {
  await mkdir('.cache/profiles', { recursive: true }); profile = await mkdtemp(resolve('.cache/profiles/shell-'));
  const extension = resolve('.cache/authorized-extension');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.addInitScript(() => {
    const probe: Probe = { live: 0, cleared: [], delayed: 0 };
    (window as InstrumentedWindow).navigationProbe = probe;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      ended = false; slow = new Set<number>();
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); probe.live++; }
      override terminate() { if (!this.ended) { this.ended = true; probe.live--; } super.terminate(); }
      override postMessage(message: { type: string; query?: string; queryId: number }) {
        if (message.type === 'search' && message.query === 'slow-old') this.slow.add(message.queryId);
        super.postMessage(message);
      }
      override set onmessage(handler: ((this: Worker, event: MessageEvent) => unknown) | null) {
        super.onmessage = event => {
          if (this.slow.has(event.data.queryId)) { probe.delayed++; setTimeout(() => handler?.call(this, event), 500); }
          else handler?.call(this, event);
        };
      }
    };
    if (!chrome.runtime?.connect) return;
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = ((info: chrome.runtime.ConnectInfo) => {
      const port = connect(info), post = port.postMessage.bind(port);
      port.postMessage = message => {
        if (message.type === 'cleared') probe.cleared.push({ workers: probe.live,
          editors: document.querySelectorAll('#note-body').length,
          details: document.querySelectorAll('[aria-label="Archive capture detail"], [aria-label="Recalled note"]').length });
        post(message);
      };
      return port;
    }) as typeof chrome.runtime.connect;
  });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  base = `chrome-extension://${new URL(sw.url()).host}`;
  library = await context.newPage(); await library.goto(`${base}/library.html`);
  await expect(library.locator('[data-search-phase="ready"]')).toBeVisible();
  generation = (await send('ListNotes', { offset: 0 })).library.generation;
});
test.afterEach(async () => {
  await context?.close();
  const child = relative(resolve('.cache/profiles'), resolve(profile));
  if (!child.startsWith('shell-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe profile cleanup');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function send(type: string, fields: Record<string, unknown> = {}) {
  return library.evaluate(command => chrome.runtime.sendMessage(command), { protocolVersion: 1, type, ...fields });
}
async function create(title: string, bodyMarkdown = `Useful details for ${title}`) {
  const result = await send('SaveManualNote', { generation, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId: null, expectedRecordVersion: null,
    fields: { title, bodyMarkdown, type: 'personal_note', tags: [], personalExplanation: '', applicableVersion: '', reviewAfter: null } });
  expect(result.ok).toBe(true); return result.result.knowledgeId as string;
}
async function go(name: 'Knowledge' | 'Archive' | 'Settings', page = library) {
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
}
async function capture(extraMessages = 0) {
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-synthetic.html' }));
  await go('Settings'); await library.getByRole('button', { name: 'Enable ChatGPT' }).click();
  const provider = await context.newPage(); await provider.goto('https://chatgpt.com/c/synthetic-a0');
  if (extraMessages) await provider.evaluate(count => {
    for (let i = 0; i < count; i++) {
      const article = document.createElement('article');
      article.setAttribute('data-message-author-role', 'assistant'); article.setAttribute('data-message-id', `extra-${i}`);
      const paragraph = document.createElement('p'); paragraph.textContent = `Retained message ${i}: exact-anchor-${i} 中文`;
      article.append(paragraph); document.querySelector('main')!.append(article);
    }
  }, extraMessages);
  await provider.getByRole('button', { name: 'Save loaded conversation', exact: true }).click();
  await provider.getByRole('button', { name: 'Confirm Archive capture' }).click();
  await expect(provider.getByText(`Saved ${3 + extraMessages} loaded messages`, { exact: false })).toBeVisible();
  const result = await send('ListArchiveCaptures', { offset: 0, conversationId: null });
  await provider.close(); return result.captures[0].id as string;
}
async function live(page = library) { return page.evaluate(() => (window as InstrumentedWindow).navigationProbe.live); }

test('only the active destination is visible, with native Back/Forward and search disposal', async () => {
  await expect(library.getByRole('region', { name: 'Manual knowledge library' })).toBeVisible();
  await expect(library.getByRole('heading', { name: 'Backup and restore' })).toBeHidden();
  await expect.poll(() => live()).toBe(1);
  await go('Archive'); await expect(library.locator('[data-archive-phase="ready"]')).toBeVisible();
  await expect(library.getByRole('region', { name: 'Manual knowledge library' })).toBeHidden();
  await expect.poll(() => live()).toBe(1);
  await go('Settings'); await expect.poll(() => live()).toBe(0);
  await expect(library.getByRole('heading', { name: 'Backup and restore' })).toBeVisible();
  await expect(library.getByRole('region', { name: 'Archive recall' })).toBeHidden();
  await library.goBack(); await expect(library.getByRole('link', { name: 'Archive', exact: true })).toHaveAttribute('aria-current', 'page');
  await library.goBack(); await expect(library.getByRole('heading', { name: 'Knowledge', exact: true })).toBeFocused();
  await library.goForward(); await expect(library.locator('[data-archive-phase="ready"]')).toBeVisible();
  await library.goForward(); await expect.poll(() => live()).toBe(0);
  expect(new URL(library.url()).search).toBe('?view=settings');
});

test('direct notes open in reading mode and dirty navigation offers Save, Discard or Cancel with a consistent URL', async () => {
  const first = await create('First note'), second = await create('Second note');
  await library.goto(`${base}/library.html?note=${first}`);
  await expect(library.locator('.editor-heading h2')).toHaveText('First note');
  await expect(library.getByLabel('Body (Markdown)')).toHaveCount(0);
  await expect(library.getByRole('link', { name: 'Knowledge', exact: true })).toHaveAttribute('aria-current', 'page');
  await library.getByRole('button', { name: 'Second note', exact: true }).click();
  await expect(library.locator('.editor-heading h2')).toHaveText('Second note');
  expect(new URL(library.url()).searchParams.get('note')).toBe(second);
  await library.goBack(); await expect(library.locator('.editor-heading h2')).toHaveText('First note');
  await library.goForward(); await expect(library.locator('.editor-heading h2')).toHaveText('Second note');
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('Do not lose this draft');
  await go('Archive'); await go('Settings'); await go('Knowledge');
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('Do not lose this draft');
  await library.goBack(); await library.goBack(); await library.goBack(); await library.goBack();
  await expect(library.getByRole('dialog')).toContainText('Your current draft is still open');
  await expect.poll(() => new URL(library.url()).searchParams.get('note')).toBe(second);
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('Do not lose this draft');
  await library.getByRole('button', { name: 'Cancel switching' }).click();
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('Do not lose this draft');
  await library.goBack(); await library.getByRole('button', { name: 'Discard and switch' }).click();
  await expect(library.locator('.editor-heading h2')).toHaveText('First note');
  await library.goForward(); await expect(library.locator('.editor-heading h2')).toHaveText('Second note');
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('Save before switching');
  await library.getByRole('button', { name: 'First note', exact: true }).click();
  await library.getByRole('button', { name: 'Save and switch' }).click();
  await expect(library.locator('.editor-heading h2')).toHaveText('First note');
  expect((await send('GetNote', { generation, noteId: second, historyOffset: 0 })).note.bodyMarkdown).toBe('Save before switching');
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('My competing draft');
  expect((await send('SaveManualNote', { generation, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId: first, expectedRecordVersion: 1,
    fields: { title: 'First note', bodyMarkdown: 'Saved by another editor', type: 'personal_note', tags: [], personalExplanation: '', applicableVersion: '', reviewAfter: null } })).ok).toBe(true);
  await library.getByRole('button', { name: 'Second note', exact: true }).click();
  await library.getByRole('button', { name: 'Save and switch' }).click();
  await expect(library.getByRole('dialog').getByRole('alert')).toContainText('VERSION_CONFLICT');
  expect(new URL(library.url()).searchParams.get('note')).toBe(first);
  await library.getByRole('button', { name: 'Cancel switching' }).click();
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('My competing draft');
  await library.getByRole('button', { name: 'Use latest saved version' }).click();
  await expect(library.locator('.note-reading')).toHaveText('Saved by another editor');
});

test('direct capture links, close and Back/Forward restore Archive detail', async () => {
  const id = await capture(); await library.goto(`${base}/library.html?capture=${id}`);
  const detail = library.getByRole('article', { name: 'Archive capture detail' });
  await expect(detail).toContainText('Explain HT-928');
  await expect(library.getByRole('link', { name: 'Archive', exact: true })).toHaveAttribute('aria-current', 'page');
  await library.getByRole('button', { name: 'Back to conversations' }).click(); await expect(detail).toHaveCount(0);
  await library.goBack(); await expect(detail).toContainText('Explain HT-928');
  await library.goForward(); await expect(detail).toHaveCount(0);
  await library.getByLabel('Search Archive', { exact: true }).fill('HT-928');
  await library.getByRole('button', { name: 'Open assistant source' }).first().click();
  expect(new URL(library.url()).searchParams.get('capture')).toBe(id);
  expect(new URL(library.url()).searchParams.has('revision')).toBe(true);
  await go('Settings'); await library.goBack(); await expect(detail).toContainText('Matching revision');
});

test('late search callbacks cannot revive inactive results and the side panel stays focused on recall', async () => {
  await create('Old result', 'slow-old'); await create('New result', 'fresh-token');
  await library.getByLabel('Search saved Knowledge').fill('slow-old');
  await expect.poll(() => library.evaluate(() => (window as InstrumentedWindow).navigationProbe.delayed)).toBeGreaterThan(0);
  await go('Settings'); await expect.poll(() => live()).toBe(0);
  await library.waitForTimeout(650); // Deliver the deliberately delayed callback after disposal.
  expect(await library.locator('.results li').count()).toBe(0);
  await go('Knowledge'); await library.getByLabel('Search saved Knowledge').fill('fresh-token');
  await expect(library.locator('.results h3')).toHaveText('New result');
  const panel = await context.newPage(); await panel.goto(`${base}/sidepanel.html`);
  await expect(panel.getByRole('link', { name: 'Open full library' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Backup and restore' })).toHaveCount(0);
  await panel.getByLabel('Search collection').selectOption('archive'); await expect(panel.locator('[data-archive-phase="ready"]')).toBeVisible();
  await expect.poll(() => live(panel)).toBe(1);
  await panel.getByLabel('Search collection').selectOption('knowledge'); await expect(panel.locator('[data-search-phase="ready"]')).toBeVisible();
  await expect.poll(() => live(panel)).toBe(1);
});

test('routine worker disconnect preserves a hidden editor and its pending save receipt', async () => {
  await library.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (async (command: { type: string }) => {
      if (command.type === 'GetNote') throw new Error('Synthetic hydration failure');
      return send(command);
    }) as unknown as typeof chrome.runtime.sendMessage;
  });
  await library.getByLabel('Body (Markdown)').fill('Committed but not hydrated');
  await library.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(library.getByRole('button', { name: 'Retry same save' })).toBeVisible();
  await go('Settings');
  const cdp = await context.newCDPSession(library);
  let versionId = '';
  cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) if (version.scriptURL === `${base}/service-worker.js` && version.runningStatus === 'running') versionId = version.versionId; });
  await cdp.send('ServiceWorker.enable'); await expect.poll(() => versionId).not.toBe('');
  await cdp.send('ServiceWorker.stopWorker', { versionId });
  await expect.poll(async () => (await send('ListNotes', { offset: 0 })).ok).toBe(true);
  await go('Knowledge');
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('Committed but not hydrated');
  await expect(library.getByRole('button', { name: 'Retry same save' })).toBeVisible();
  await expect(library.getByRole('button', { name: 'New note', exact: true })).toBeDisabled();
  expect((await send('ListNotes', { offset: 0 })).library.total).toBe(1);
  await cdp.detach();
});

test('A5 deletion clears hidden drafts, Archive details and workers before acknowledgement', async () => {
  const note = await create('Delete me'), id = await capture();
  await library.goto(`${base}/library.html?note=${note}`);
  await expect(library.locator('.editor-heading h2')).toHaveText('Delete me');
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('Hidden unsaved text'); await go('Settings');
  const second = await context.newPage(); await second.goto(`${base}/library.html?capture=${id}`);
  await expect(second.getByRole('article', { name: 'Archive capture detail' })).toContainText('Explain HT-928');
  await library.getByText('Cleanup and deletion', { exact: true }).click();
  await library.getByRole('button', { name: 'Preview Delete all data' }).click();
  await library.getByRole('button', { name: 'Confirm permanent deletion' }).click();
  for (const page of [library, second]) {
    await expect.poll(() => page.evaluate(() => (window as InstrumentedWindow).navigationProbe.cleared.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as InstrumentedWindow).navigationProbe.cleared)).toEqual([{ workers: 0, editors: 0, details: 0 }]);
  }
  await go('Knowledge'); await expect(library.getByLabel('Body (Markdown)')).toHaveValue('');
  await expect(second.getByRole('article', { name: 'Archive capture detail' })).toHaveCount(0);
  expect((await send('ListNotes', { offset: 0 })).library.total).toBe(0);
  await library.getByLabel('Body (Markdown)').fill('New draft after deletion');
  await library.goBack(); await library.goBack();
  await expect(library.getByRole('dialog')).toContainText('Your current draft is still open');
  await library.getByRole('button', { name: 'Cancel switching' }).click();
  await go('Knowledge');
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('New draft after deletion');
});

test('A6 restore preview survives destination changes and clears every view before activation', async () => {
  const note = await create('Keep through restore'); await go('Settings');
  await library.getByText('Restore a JSON backup', { exact: true }).click();
  const downloading = library.waitForEvent('download'); await library.getByRole('button', { name: 'Download backup' }).click();
  const bytes = await readFile((await (await downloading).path())!);
  await library.getByLabel('Choose canonical backup').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes });
  await expect(library.getByRole('region', { name: 'Restore preview' })).toBeVisible();
  await go('Knowledge'); await library.getByRole('button', { name: 'Refresh library' }).click();
  await library.getByRole('button', { name: 'Keep through restore', exact: true }).click();
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('Hidden restore draft'); await go('Settings');
  await expect(library.getByRole('region', { name: 'Restore preview' })).toBeVisible();
  const second = await context.newPage(); await second.goto(`${base}/library.html?note=${note}`);
  await expect(second.locator('.editor-heading h2')).toHaveText('Keep through restore');
  await library.getByLabel('I reviewed the replacement and saved any current data I need.').check();
  await library.getByRole('button', { name: 'Confirm restore', exact: true }).click();
  for (const page of [library, second]) {
    await expect.poll(() => page.evaluate(() => (window as InstrumentedWindow).navigationProbe.cleared.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as InstrumentedWindow).navigationProbe.cleared)).toEqual([{ workers: 0, editors: 0, details: 0 }]);
  }
  await go('Knowledge'); await expect(library.getByLabel('Body (Markdown)')).toHaveValue('');
  await expect(second.getByLabel('Body (Markdown)')).toHaveValue('');
  expect((await send('ListNotes', { offset: 0 })).library.generation).not.toBe(generation);
});

test('a save finishing in Settings updates the remembered note link without changing destinations', async () => {
  await library.evaluate(() => {
    const runtime = chrome.runtime as unknown as { sendMessage(command: { type: string }): Promise<unknown> };
    const send = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = async command => {
      const reply = await send(command);
      if (command.type === 'GetNote') await new Promise<void>(resolve => { (window as unknown as { releaseHydration: () => void }).releaseHydration = resolve; });
      return reply;
    };
  });
  await library.getByLabel('Body (Markdown)').fill('Finish the save in the background');
  await library.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect.poll(() => library.evaluate(() => typeof (window as unknown as { releaseHydration?: () => void }).releaseHydration)).toBe('function');
  await go('Settings');
  await library.evaluate(() => (window as unknown as { releaseHydration: () => void }).releaseHydration());
  const id = (await send('ListNotes', { offset: 0 })).library.notes[0].id;
  await expect(library.getByRole('link', { name: 'Knowledge', exact: true })).toHaveAttribute('href', `${base}/library.html?note=${id}`);
  expect(new URL(library.url()).search).toBe('?view=settings');
  await go('Knowledge'); await expect(library.locator('.note-reading')).toHaveText('Finish the save in the background');
  await expect(library.getByLabel('Body (Markdown)')).toHaveCount(0);
});

test('a late save hydration cannot navigate or repopulate a cleared editor', async () => {
  await library.evaluate(() => {
    const runtime = chrome.runtime as unknown as { sendMessage(command: { type: string }): Promise<unknown> };
    const send = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = async command => {
      const reply = await send(command);
      if (command.type === 'GetNote') await new Promise<void>(resolve => { (window as unknown as { releaseHydration: () => void }).releaseHydration = resolve; });
      return reply;
    };
  });
  await library.getByLabel('Body (Markdown)').fill('Late saved content');
  await library.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect.poll(() => library.evaluate(() => typeof (window as unknown as { releaseHydration?: () => void }).releaseHydration)).toBe('function');
  const second = await context.newPage(); await second.goto(`${base}/library.html?view=settings`);
  await second.getByText('Cleanup and deletion', { exact: true }).click();
  await second.getByRole('button', { name: 'Preview Delete all data' }).click();
  await second.getByRole('button', { name: 'Confirm permanent deletion' }).click();
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('');
  await library.evaluate(() => (window as unknown as { releaseHydration: () => void }).releaseHydration());
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('');
  expect(new URL(library.url()).searchParams.has('note')).toBe(false);
  expect((await send('ListNotes', { offset: 0 })).library.total).toBe(0);
});

test('desktop and 360px layouts keep deep-linked details at the top without horizontal overflow', async () => {
  const note = await create('Local semantic search', 'Keep useful ideas close. Compare exact matches with related notes, and retain the original sources.\n\n## A useful recall workflow\n\n- Start with an exact phrase or a specific identifier.\n- Read the saved note and check its source.\n- Endorse it only after verifying the advice.\n\n```ts\nconst query = "知识 memory";\n```');
  await create('ChatGPT export strategy'); await create('Codex versus Pi');
  const id = await capture();
  for (const width of [1440, 360]) {
    await library.setViewportSize({ width, height: 900 });
    for (const [destination, query, target] of [
      ['knowledge', `note=${note}`, '.editor-heading h2'],
      ['archive', `capture=${id}`, '[aria-label="Archive capture detail"] h3'],
      ['settings', 'view=settings', '#capture-title'],
    ]) {
      await library.goto(`${base}/library.html?${query}`);
      if (destination === 'knowledge') await expect(library.locator('.editor-heading h2')).toHaveText('Local semantic search');
      if (destination === 'archive') await expect(library.getByRole('article', { name: 'Archive capture detail' })).toContainText('Explain HT-928');
      const element = library.locator(target!); await expect(element).toBeVisible();
      const box = (await element.boundingBox())!; expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThan(900);
      expect(await library.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(await library.evaluate(() => window.scrollY)).toBe(0);
      await mkdir('artifacts/screenshots/navigation', { recursive: true });
      await library.screenshot({ path: `artifacts/screenshots/navigation/${destination}-${width}.png`, fullPage: destination === 'settings' });
    }
  }
});

test('narrow Knowledge keeps search, draft and list position while moving between panes', async () => {
  const first = await create('First responsive note', 'Responsive exact content');
  await create('Second responsive note', 'Responsive second content');
  await library.reload(); await library.setViewportSize({ width: 360, height: 900 });
  await library.getByLabel('Search saved Knowledge').fill('responsive');
  await expect(library.locator('.note-list')).toHaveCount(0);
  await library.getByRole('button', { name: 'Recall First responsive note', exact: true }).click();
  await expect(library.locator('.note-browser')).toBeHidden();
  await expect(library.locator('.note-reading')).toHaveText('Responsive exact content');
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('Preserve this mobile draft');
  await library.getByRole('button', { name: 'Back to notes', exact: true }).click();
  await expect(library.getByLabel('Search saved Knowledge')).toHaveValue('responsive');
  await library.getByRole('button', { name: 'Recall Second responsive note', exact: true }).click();
  await library.getByRole('button', { name: 'Cancel switching' }).click();
  expect(new URL(library.url()).searchParams.get('note')).toBe(first);
  await library.getByRole('button', { name: 'Recall First responsive note', exact: true }).click();
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('Preserve this mobile draft');
  await library.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(library.locator('.note-reading')).toHaveText('Responsive exact content');
  await library.getByRole('button', { name: 'Back to notes', exact: true }).click();
  await library.screenshot({ path: 'artifacts/screenshots/navigation/knowledge-list-360.png' });
  await library.getByRole('button', { name: 'New note', exact: true }).click();
  await expect(library.getByLabel('Title (optional)')).toBeFocused();
  await library.getByLabel('Body (Markdown)').fill('A new mobile note');
  await library.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(library.locator('.note-reading')).toHaveText('A new mobile note');
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('Dirty new-note transition');
  await library.getByRole('button', { name: 'Back to notes', exact: true }).click();
  await library.getByRole('button', { name: 'New note', exact: true }).click();
  await library.getByRole('button', { name: 'Discard and switch' }).click();
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('');
  expect(new URL(library.url()).searchParams.has('note')).toBe(false);
});

test('a failed note open cannot leave the previous note under the requested URL', async () => {
  const first = await create('Readable note'), second = await create('Temporarily unavailable');
  await library.goto(`${base}/library.html?note=${first}`);
  await expect(library.locator('.editor-heading h2')).toHaveText('Readable note');
  await library.evaluate(id => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime); let once = true;
    chrome.runtime.sendMessage = (async (command: { type: string; noteId?: string }) => {
      if (command.type === 'GetNote' && command.noteId === id && once) { once = false; throw new Error('Synthetic read failure'); }
      return send(command);
    }) as unknown as typeof chrome.runtime.sendMessage;
  }, second);
  await library.getByRole('button', { name: 'Temporarily unavailable', exact: true }).click();
  await expect(library.getByRole('heading', { name: 'Note unavailable' })).toBeVisible();
  expect(new URL(library.url()).searchParams.get('note')).toBe(second);
  await expect(library.locator('.note-reading')).toHaveCount(0);
  await library.getByRole('button', { name: 'Retry opening note' }).click();
  await expect(library.locator('.editor-heading h2')).toHaveText('Temporarily unavailable');
});

test('review retry remains accessible and prevents switching until the original action is resolved', async () => {
  const first = await create('Review this note'); await create('Other note');
  await library.goto(`${base}/library.html?note=${first}`);
  await library.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime); let once = true;
    const attempts: string[] = [];
    (window as unknown as { reviewAttempts: string[] }).reviewAttempts = attempts;
    chrome.runtime.sendMessage = (async (command: { type: string; requestId?: string }) => {
      if (command.type === 'ReviewNote') attempts.push(command.requestId!);
      const reply = await send(command);
      if (command.type === 'ReviewNote' && once) { once = false; throw new Error('Synthetic lost acknowledgement'); }
      return reply;
    }) as unknown as typeof chrome.runtime.sendMessage;
  });
  await library.getByRole('button', { name: 'Endorse note' }).click();
  await expect(library.getByRole('button', { name: 'Retry curation action' })).toBeVisible();
  await library.getByRole('button', { name: 'Other note', exact: true }).click();
  await expect(library.getByRole('button', { name: 'Discard and switch' })).toBeDisabled();
  await library.getByRole('button', { name: 'Cancel switching' }).click();
  await library.getByRole('button', { name: 'Retry curation action' }).click();
  await expect(library.getByRole('button', { name: 'Endorse note' })).toBeDisabled();
  const attempts = await library.evaluate(() => (window as unknown as { reviewAttempts: string[] }).reviewAttempts);
  expect(attempts).toHaveLength(2); expect(attempts[0]).toBe(attempts[1]);
  await library.getByText('Review and other actions', { exact: true }).click();
  await library.getByRole('button', { name: 'Duplicate as new' }).click();
  await expect.poll(() => new URL(library.url()).searchParams.get('note')).not.toBe(first);
  expect((await send('ListNotes', { offset: 0 })).library.total).toBe(3);
});

test('Archive opens the exact later-page revision, preserves results on return, and retains code whitespace', async () => {
  const id = await capture(14);
  await library.goto(`${base}/library.html?capture=${id}`);
  const initial = await send('GetArchiveCapture', { generation, captureId: id, offset: 0 });
  const code = initial.detail.revisions[1].blocks.find((block: { kind: string }) => block.kind === 'code').text;
  await expect(library.locator('.archive-code code')).toHaveText(code);
  const revision = initial.detail.capture.revisionIds[14];
  await library.goto(`${base}/library.html?capture=${id}&revision=${revision}`);
  const match = library.locator(`[data-revision-id="${revision}"]`);
  await expect(match).toHaveClass('matching-message'); await expect(match).toBeFocused();
  await expect(match).toContainText('exact-anchor-11 中文');
  await expect(library.getByRole('article', { name: 'Archive capture detail' })).toContainText('9–16 of 17');
  await library.getByRole('button', { name: 'Back to conversations' }).click();
  await library.setViewportSize({ width: 360, height: 900 });
  await library.getByLabel('Search Archive', { exact: true }).fill('exact-anchor-11');
  const hit = library.getByRole('button', { name: 'Open assistant source' });
  await expect(hit).toHaveCount(1);
  await expect(library.locator('[aria-label="Archive search results"] pre')).toHaveCount(0);
  await library.screenshot({ path: 'artifacts/screenshots/navigation/archive-list-360.png' });
  await hit.click(); await expect(match).toBeFocused();
  await expect(library.locator('.archive-browser')).toBeHidden();
  await library.getByRole('button', { name: 'Back to conversations' }).click();
  await expect(library.getByLabel('Search Archive', { exact: true })).toHaveValue('exact-anchor-11');
  await expect(hit).toBeFocused();
});

test('Phase 3 settings disclosures, deletion focus, permission errors and Chrome configuration', async () => {
  await create('Keep this note'); await go('Settings');
  await expect(library.getByRole('button', { name: 'Download backup', exact: true })).toBeVisible();
  await expect(library.getByLabel('Choose canonical backup')).not.toBeVisible();
  await expect(library.getByRole('button', { name: 'Preview Delete all data' })).not.toBeVisible();
  const cleanup = library.getByText('Cleanup and deletion', { exact: true });
  await cleanup.focus(); await library.keyboard.press('Enter');
  await library.getByRole('button', { name: 'Preview Delete all data' }).click();
  await expect(library.getByRole('heading', { name: 'Review permanent deletion' })).toBeFocused();
  await library.getByRole('button', { name: 'Cancel deletion' }).click();
  await expect(library.getByRole('button', { name: 'Preview Delete all data' })).toBeFocused();
  expect((await send('ListNotes', { offset: 0 })).library.total).toBe(1);
  await cleanup.focus(); await library.keyboard.press('Space');
  await expect(library.getByRole('button', { name: 'Preview Delete all data' })).not.toBeVisible();
  await library.evaluate(() => { chrome.permissions.request = async () => { throw new Error('Synthetic permission error'); }; });
  await library.getByRole('button', { name: 'Enable ChatGPT', exact: true }).click();
  await expect(library.getByRole('alert')).toContainText('Could not enable ChatGPT');
  await expect(library.getByText('ChatGPT: Disabled', { exact: true })).toBeVisible();
  await expect(library.getByRole('button', { name: 'Enable ChatGPT', exact: true })).toBeEnabled();
  const tabOpened = context.waitForEvent('page');
  await library.getByRole('button', { name: 'Configure shortcuts' }).click();
  const shortcuts = await tabOpened; await expect(shortcuts).toHaveURL('chrome://extensions/shortcuts'); await shortcuts.close();
});

test('Phase 3 side panel recent recall, exact copy, deep links and keyboard return at narrow widths', async () => {
  const body = 'Readable 中文 content.\n\n```ts\nconst exact = "知识";\n```\n\nhttps://example.com/' + 'long-path-'.repeat(40);
  const noteId = await create('Daily recall 知识', body);
  const captureId = await capture();
  const panel = await context.newPage(); await panel.setViewportSize({ width: 360, height: 800 }); await panel.goto(`${base}/sidepanel.html`);
  await panel.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { (window as Window & { copied?: string }).copied = text; } });
  });
  await expect(panel.getByText('Recent notes · stored on this device', { exact: true })).toBeVisible();
  const result = panel.getByRole('button', { name: 'Recall Daily recall 知识', exact: true });
  await expect(result).toBeVisible();
  await mkdir('artifacts/screenshots/navigation', { recursive: true });
  await panel.screenshot({ path: 'artifacts/screenshots/navigation/sidepanel-360.png' });
  await panel.getByRole('button', { name: 'Copy excerpt', exact: true }).click();
  expect(await panel.evaluate(() => (window as Window & { copied?: string }).copied)).toBe(await panel.locator('.list-preview').textContent());
  await panel.getByLabel('Search saved Knowledge').fill('Readable');
  await expect(result).toBeVisible(); await panel.getByLabel('Search saved Knowledge').press('ArrowDown'); await expect(result).toBeFocused(); await panel.keyboard.press('Enter');
  await expect(panel.getByRole('heading', { name: 'Daily recall 知识', exact: true })).toBeFocused();
  await expect(panel.getByRole('link', { name: 'Open note in full library' })).toHaveAttribute('href', `${base}/library.html?note=${noteId}`);
  await panel.getByRole('button', { name: 'Copy visible note' }).click();
  const saved = await send('GetNote', { generation, noteId, historyOffset: 0 });
  expect(await panel.evaluate(() => (window as Window & { copied?: string }).copied)).toBe(saved.note.plainText);
  await expect(panel.getByRole('status').filter({ hasText: 'Copied retained text.' })).toBeVisible();
  for (const width of [360, 320]) {
    await panel.setViewportSize({ width, height: 800 });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.screenshot({ path: 'artifacts/screenshots/navigation/sidepanel-note-360.png' });
  await panel.keyboard.press('Escape'); await expect(result).toBeFocused();
  await expect(panel.getByLabel('Search saved Knowledge')).toHaveValue('Readable');
  await panel.getByLabel('Search collection').selectOption('archive');
  await expect(panel.locator('[data-archive-phase="ready"]')).toBeVisible();
  await panel.getByLabel('Search Archive', { exact: true }).fill('HT-928');
  const source = panel.getByRole('button', { name: 'Open user source', exact: true }); await source.click();
  await expect(panel.getByRole('link', { name: 'Open conversation in full library' })).toHaveAttribute('href', new RegExp(`capture=${captureId}&revision=`));
  await expect(panel.getByText('Manage this conversation', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Add this source to Knowledge', { exact: true })).toHaveCount(0);
  const match = panel.locator('.matching-message'); await expect(match).toContainText('Explain HT-928');
  await expect(match.getByRole('heading', { name: 'You', exact: true, level: 3 })).toBeVisible();
  await match.getByRole('button', { name: 'Copy message text' }).click();
  expect(await panel.evaluate(() => (window as Window & { copied?: string }).copied)).toContain('Explain HT-928');
  expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await panel.screenshot({ path: 'artifacts/screenshots/navigation/sidepanel-archive-360.png' });
  await panel.getByRole('button', { name: 'Back to conversations' }).click(); await expect(source).toBeFocused();
  await expect.poll(() => live(panel)).toBe(1);
  await panel.close();
});

test('Phase 3 native 200 percent tab zoom and expanded settings remain usable', async () => {
  await create('Zoom note 中文', 'Readable at browser zoom.\n\n```ts\nconst long = "' + 'long'.repeat(90) + '";\n```');
  const captureId = await capture();
  await library.setViewportSize({ width: 1440, height: 1000 }); await go('Settings');
  await library.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.tabs.setZoom(tab!.id!, 2); });
  await expect.poll(() => library.evaluate(() => chrome.tabs.getZoom())).toBe(2);
  expect(await library.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await library.getByText('Restore a JSON backup', { exact: true }).click();
  await library.getByText('Cleanup and deletion', { exact: true }).click();
  await expect(library.getByRole('button', { name: 'Preview Delete all data' })).toBeVisible();
  expect(await library.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await library.evaluate(() => window.scrollTo(0, 0));
  await library.screenshot({ path: 'artifacts/screenshots/navigation/settings-zoom-200.png' });
  await go('Knowledge'); await library.getByRole('button', { name: 'Zoom note 中文', exact: true }).click();
  expect(await library.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await library.goto(base + '/library.html?capture=' + captureId);
  await expect(library.getByRole('article', { name: 'Archive capture detail' })).toContainText('Explain HT-928');
  expect(await library.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const panel = await context.newPage(); await panel.setViewportSize({ width: 720, height: 1000 }); await panel.goto(base + '/sidepanel.html');
  await panel.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.tabs.setZoom(tab!.id!, 2); });
  await expect(panel.locator('[data-search-phase="ready"]')).toBeVisible();
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.close();
  await library.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.tabs.setZoom(tab!.id!, 1); });
});

test('Phase 3 draft dialog supports keyboard navigation and restores its trigger on Cancel and Escape', async () => {
  await create('First focus note'); await create('Second focus note');
  await library.getByRole('button', { name: 'First focus note', exact: true }).click();
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await library.getByLabel('Body (Markdown)').fill('Unsaved focus draft');
  const trigger = library.getByRole('button', { name: 'Second focus note', exact: true });
  for (const escape of [false, true]) {
    await trigger.click(); const dialog = library.getByRole('dialog'); await expect(dialog).toBeVisible();
    await library.getByRole('button', { name: 'Cancel switching' }).focus();
    await library.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Discard and switch' })).toBeFocused();
    await library.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Cancel switching' })).toBeFocused();
    if (escape) await library.keyboard.press('Escape'); else await dialog.getByRole('button', { name: 'Cancel switching' }).click();
    await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    await expect(library.getByLabel('Body (Markdown)')).toHaveValue('Unsaved focus draft');
  }
});

test('Phase 3 restore validation, confirmation gating and cancellation focus survive disclosures', async () => {
  await create('Preserve during preview'); await go('Settings');
  const downloadEvent = library.waitForEvent('download'); await library.getByRole('button', { name: 'Download backup', exact: true }).click();
  const bytes = await readFile((await (await downloadEvent).path())!);
  const disclosure = library.getByText('Restore a JSON backup', { exact: true }); await disclosure.focus(); await library.keyboard.press('Enter');
  const input = library.getByLabel('Choose canonical backup');
  await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(library.locator('[aria-labelledby="backup-title"]').getByRole('alert')).toBeVisible();
  await expect(library.getByRole('region', { name: 'Restore preview' })).toHaveCount(0);
  expect((await send('ListNotes', { offset: 0 })).library.total).toBe(1);
  await input.setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: bytes });
  await expect(library.getByRole('heading', { name: 'Review library replacement' })).toBeFocused();
  const confirm = library.getByRole('button', { name: 'Confirm restore', exact: true }); await expect(confirm).toBeDisabled();
  await library.getByRole('checkbox', { name: 'I reviewed the replacement' }).check(); await expect(confirm).toBeEnabled();
  await disclosure.click(); await expect(confirm).not.toBeVisible();
  await expect(library.getByRole('button', { name: 'Cancel preview / finish cleanup' })).toBeVisible();
  await library.getByRole('button', { name: 'Cancel preview / finish cleanup' }).click(); await expect(disclosure).toBeFocused();
  await expect(library.getByRole('region', { name: 'Restore preview' })).toHaveCount(0);
  expect((await send('ListNotes', { offset: 0 })).library.total).toBe(1);
});
