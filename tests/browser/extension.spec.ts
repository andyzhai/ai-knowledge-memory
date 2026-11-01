import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

let context: BrowserContext;
let sw: Worker;
let extensionId: string;
let library: Page;
let profile: string;
const fixtureUrl = 'https://chatgpt.com/c/synthetic-a0';

test.beforeEach(async ({}, testInfo) => {
  await mkdir('.cache/profiles', { recursive: true });
  profile = await mkdtemp(resolve('.cache/profiles/a0-'));
  const packagePath = resolve(testInfo.title.includes('[authorized fixture]') ? '.cache/authorized-extension' : 'dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${packagePath}`, `--load-extension=${packagePath}`],
  });
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(sw.url()).host;
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-synthetic.html' }));
  library = await context.newPage();
  await library.goto(`chrome-extension://${extensionId}/library.html`);
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(library.getByText('ChatGPT: Disabled')).toBeVisible();
  await library.getByRole('link', { name: 'Knowledge', exact: true }).click();
});
test.afterEach(async () => {
  await context?.close();
  // Delete only this test's newly allocated profile, inside the workspace root.
  const base = resolve('.cache/profiles');
  const child = relative(base, resolve(profile));
  if (!child.startsWith('a0-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe test profile cleanup path');
  await rm(resolve(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('production shell starts its packaged worker without provider permissions or network', async () => {
  const requests: string[] = [];
  context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await library.reload();
  await expect(library.locator('[data-search-phase="ready"]')).toBeVisible();
  await library.getByLabel('Search saved Knowledge').fill('unfindable-987');
  await expect(library.getByText('No matching Knowledge. Try fewer terms or broaden the search.')).toBeVisible();
  expect(requests).toEqual([]);
  expect(await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
  expect(await library.evaluate(async () => (await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).library.total)).toBe(0);
  const settings = await sw.evaluate(() => chrome.storage.local.get(null));
  expect(Object.keys(settings).sort()).toEqual(['activeLibrary', 'chatgptProbeEnabled']);
  const provider = await context.newPage(); await provider.goto(fixtureUrl);
  await expect(provider.locator('#akm-a0-probe')).toHaveCount(0);
});

test('denied permission leaves local recall available and creates no registration', async () => {
  // This injects the denial outcome in the UI only; real grant path is tested below.
  await library.evaluate(() => { chrome.permissions.request = async () => false; });
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await library.getByRole('button', { name: 'Enable ChatGPT' }).click();
  await expect(library.getByText('Access was not granted. Local Knowledge search remains available.')).toBeVisible();
  expect(await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
  await library.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await expect(library.locator('[data-search-phase="ready"]')).toBeVisible();
});

async function enable() {
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await library.getByRole('button', { name: 'Enable ChatGPT' }).click();
  await expect(library.getByText('ChatGPT: Enabled')).toBeVisible();
  await library.getByRole('link', { name: 'Knowledge', exact: true }).click();
}
async function selectCode(page: Page) {
  await page.locator('#code-text').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
}

async function contextCommand() {
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    await chrome.tabs.sendMessage(tab!.id!, { type: 'PreviewSelection', source: 'context-menu' }, { frameId: 0 });
  });
}

async function currentStructurePage() {
  const page = await context.newPage();
  await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', path: 'tests/fixtures/chatgpt-current-structure.html' }));
  await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  return page;
}

async function holdAuthorization(outcome: 'ok' | 'denied' | 'timeout' = 'ok') {
  await sw.evaluate(async outcome => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    await chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] }, args: [outcome], func: outcome => {
      // Test-only isolated-world fault injection, never bundled in production.
      const runtime = chrome.runtime as unknown as { sendMessage(message: unknown): Promise<unknown> };
      const original = runtime.sendMessage.bind(runtime);
      runtime.sendMessage = message => {
        if ((message as { type?: string }).type !== 'AuthorizePreview') return original(message);
        return new Promise(resolve => {
          (globalThis as typeof globalThis & { releaseA0Authorization?: () => void }).releaseA0Authorization = () => {
            if (outcome !== 'timeout') resolve(outcome === 'ok' ? { ok: true } : { ok: false, code: 'PERMISSION_DENIED' });
          };
        });
      };
    } });
  }, outcome);
}

async function releaseAuthorization() {
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    await chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] }, func: () => {
      (globalThis as typeof globalThis & { releaseA0Authorization?: () => void }).releaseA0Authorization?.();
    } });
  });
}

test('[authorized fixture] live-observed message structure exposes the button despite retained composer focus', async () => {
  await enable(); const page = await currentStructurePage();
  await page.locator('#composer').focus();
  await selectCode(page);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('composer');
  const selected = await page.evaluate(() => getSelection()!.toString());
  await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
  await expect(page.locator('#akm-a0-probe pre')).toBeVisible();
  expect(await page.locator('#akm-a0-probe pre').textContent()).toBe(selected);
  await expect(page.getByText('1 source fragment(s). Roles: assistant.', { exact: false })).toBeVisible();
});

test('[authorized fixture] context preview on observed structure is not silently dropped by ordinary input during authorization', async () => {
  await enable(); const page = await currentStructurePage();
  await holdAuthorization(); await selectCode(page);
  const selected = await page.evaluate(() => getSelection()!.toString());
  await page.locator('#code-text').click({ button: 'right', position: { x: 5, y: 5 } });
  await contextCommand();
  await expect(page.getByText('Checking preview permission…')).toBeVisible();
  await page.getByRole('button', { name: 'Move focus' }).click();
  await page.keyboard.press('ArrowRight');
  await releaseAuthorization();
  await expect(page.locator('#akm-a0-probe pre')).toBeVisible();
  expect(await page.locator('#akm-a0-probe pre').textContent()).toBe(selected);
});

for (const [outcome, code] of [['denied', 'PERMISSION_DENIED'], ['timeout', 'AUTHORIZATION_TIMEOUT']] as const) {
  test(`[authorized fixture] explicit preview reports ${code} visibly`, async () => {
    await enable(); const page = await currentStructurePage();
    await holdAuthorization(outcome); await selectCode(page);
    await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
    await expect(page.getByText('Checking preview permission…')).toBeVisible();
    await releaseAuthorization();
    await expect(page.getByText(new RegExp(`Preview unavailable: ${code}`))).toBeVisible();
    await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
  });
}

test('local delivery diagnostic is visible with access off and does not grant site access', async () => {
  await library.goto(`chrome-extension://${extensionId}/library.html?previewError=PERMISSION_DENIED`);
  await expect(library.getByRole('alert', { name: 'Preview unavailable' })).toContainText('PERMISSION_DENIED');
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(library.getByText('ChatGPT: Disabled')).toBeVisible();
  expect(await sw.evaluate(() => chrome.permissions.contains({ origins: ['https://chatgpt.com/*'] }))).toBe(false);
  expect(await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
});

test('[authorized fixture] disabling during an explicit preview produces local feedback and removes captured text', async () => {
  await enable(); const page = await currentStructurePage();
  await holdAuthorization(); await selectCode(page);
  await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
  await expect(page.getByText('Checking preview permission…')).toBeVisible();
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await library.getByRole('button', { name: 'Disable ChatGPT and remove access' }).click();
  await expect(page.locator('#akm-a0-probe')).toHaveCount(0);
  const diagnosticPage = context.waitForEvent('page');
  await releaseAuthorization();
  const diagnostic = await diagnosticPage;
  await expect(diagnostic.getByRole('alert', { name: 'Preview unavailable' })).toContainText('PERMISSION_DENIED');
  await diagnostic.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(diagnostic.getByText('ChatGPT: Disabled')).toBeVisible();
  await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
});

test('[authorized fixture] observed message metadata cannot bypass a sensitive editable ancestor', async () => {
  await enable(); const page = await currentStructurePage();
  await page.locator('[data-chatgpt-selection-message-id]').evaluate(node => node.setAttribute('contenteditable', 'true'));
  await selectCode(page);
  await expect(page.getByRole('button', { name: 'Preview selection', exact: true })).toBeHidden();
  await page.locator('#code-text').click({ button: 'right', position: { x: 5, y: 5 } });
  await contextCommand();
  await expect(page.getByText(/Preview unavailable: EXCLUDED_CONTENT/)).toBeVisible();
  await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
});

test('[authorized fixture] floating button handles semantic main, element endpoints and stopped bubble listeners', async () => {
  const page = await context.newPage(); await page.goto(fixtureUrl);
  await page.evaluate(() => {
    const main = document.querySelector('main')!;
    const container = document.createElement('div'); container.setAttribute('role', 'main');
    container.append(...main.childNodes); main.replaceWith(container);
    document.addEventListener('selectionchange', event => event.stopImmediatePropagation());
  });
  await enable();
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('[data-message-id="a2"]')!);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
  expect(await page.locator('#akm-a0-probe pre').textContent()).toBe('An unfinished answer');
  await expect(page.getByText('1 source fragment(s). Roles: assistant.', { exact: false })).toBeVisible();
});

test('[authorized fixture] context snapshot survives queued selectionchange and menu focus collapse', async () => {
  await enable(); const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(page);
  const selected = await page.evaluate(() => getSelection()!.toString());
  // Real right-click produces a trusted contextmenu. Model the subsequent
  // document selection notifications before delivering Chrome's menu callback.
  await page.locator('#code-text').click({ button: 'right', position: { x: 5, y: 5 } });
  await page.evaluate(() => {
    document.dispatchEvent(new Event('selectionchange'));
    getSelection()!.removeAllRanges();
  });
  await contextCommand();
  await expect(page.locator('#akm-a0-probe pre')).toBeVisible();
  expect(await page.locator('#akm-a0-probe pre').textContent()).toBe(selected);
});

test('[authorized fixture] context extraction failures retain their actual diagnostic', async () => {
  await enable(); const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await page.locator('article').evaluateAll(nodes => nodes.forEach(node => node.removeAttribute('data-message-author-role')));
  await selectCode(page);
  await page.locator('#code-text').click({ button: 'right', position: { x: 5, y: 5 } });
  await contextCommand();
  await expect(page.getByText(/Preview unavailable: ADAPTER_MISMATCH/)).toBeVisible();
  await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
});

test('[authorized fixture] floating action retains its extraction error across focus events', async () => {
  await enable(); const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(page);
  await expect(page.getByRole('button', { name: 'Preview selection', exact: true })).toBeVisible();
  await page.locator('article').evaluateAll(nodes => nodes.forEach(node => node.removeAttribute('data-message-author-role')));
  await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
  await expect(page.getByText(/Preview unavailable: ADAPTER_MISMATCH/)).toBeVisible();
});

test('[authorized fixture] floating pointer action survives a selectionchange before click without recapturing edited text', async () => {
  await enable(); const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(page);
  const selected = await page.evaluate(() => getSelection()!.toString());
  const button = page.getByRole('button', { name: 'Preview selection', exact: true });
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => {
    getSelection()!.removeAllRanges();
    document.getElementById('code-text')!.textContent = 'Later streaming/edit output';
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.mouse.up();
  await expect(page.locator('#akm-a0-probe pre')).toBeVisible();
  expect(await page.locator('#akm-a0-probe pre').textContent()).toBe(selected);
});

test('[authorized fixture] right pointerdown freezes before a provider context-menu focus change', async () => {
  await enable(); const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(page);
  const selected = await page.evaluate(() => getSelection()!.toString());
  await page.evaluate(() => {
    document.addEventListener('pointerdown', () => getSelection()!.removeAllRanges(), { once: true });
    document.addEventListener('contextmenu', event => event.stopImmediatePropagation());
  });
  await page.locator('#code-text').click({ button: 'right', position: { x: 5, y: 5 } });
  expect(await page.evaluate(() => getSelection()!.isCollapsed)).toBe(true);
  await contextCommand();
  await expect(page.locator('#akm-a0-probe pre')).toBeVisible();
  expect(await page.locator('#akm-a0-probe pre').textContent()).toBe(selected);
});

test('[authorized fixture] a different nonempty selection invalidates the pending context source', async () => {
  await enable(); const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(page);
  await page.locator('#code-text').click({ button: 'right', position: { x: 5, y: 5 } });
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.getElementById('answer-text')!);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await contextCommand();
  await expect(page.getByText(/Preview unavailable: SELECTION_CHANGED/)).toBeVisible();
  await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
});

test('[authorized fixture] cancelled context intent is not replaced by a fresh selection at callback time', async () => {
  await enable(); const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(page);
  await page.locator('#code-text').click({ button: 'right', position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Move focus' }).click();
  await contextCommand();
  await expect(page.getByText(/Preview unavailable: NO_FROZEN_SELECTION/)).toBeVisible();
  await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
});

test('[authorized fixture] context callback reports navigation even after A to B to A', async () => {
  await enable(); const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(page);
  await page.locator('#code-text').click({ button: 'right', position: { x: 5, y: 5 } });
  await page.evaluate(() => {
    history.pushState({}, '', '/c/other'); history.pushState({}, '', '/c/synthetic-a0');
  });
  await contextCommand();
  await expect(page.getByText(/Preview unavailable: NAVIGATION_CHANGED/)).toBeVisible();
  await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
});

for (const code of ['EXCLUDED_CONTENT', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_PAGE', 'NO_SELECTION']) {
  test(`[authorized fixture] context path reports ${code} without masking or fallback`, async () => {
    await enable(); const page = await context.newPage(); await page.goto(fixtureUrl);
    await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
    await page.evaluate(code => {
      if (code === 'EXCLUDED_CONTENT') document.getElementById('code-text')!.setAttribute('contenteditable', 'true');
      if (code === 'PAYLOAD_TOO_LARGE') document.getElementById('code-text')!.textContent = '中'.repeat(100_000);
      if (code === 'UNSUPPORTED_PAGE') history.pushState({}, '', '/');
    }, code);
    if (code !== 'NO_SELECTION') await selectCode(page);
    await page.locator('#code-text').click({ button: 'right', position: { x: 5, y: 5 } });
    await contextCommand();
    await expect(page.getByText(new RegExp(`Preview unavailable: ${code}`))).toBeVisible();
    await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
    expect(await library.evaluate(async () => (await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).library.total)).toBe(0);
  });
}

test('[authorized fixture] enable injects existing/new pages, freezes selection, and disable disposes both', async () => {
  const existing = await context.newPage(); await existing.goto(fixtureUrl);
  await library.bringToFront(); await enable();
  await expect(existing.locator('#akm-a0-probe')).toHaveCount(1);
  await library.evaluate(() => chrome.runtime.sendMessage({ protocolVersion: 1, type: 'SetProviderEnabled', enabled: true }));
  await expect(existing.locator('#akm-a0-probe')).toHaveCount(1);
  const fresh = await context.newPage(); await fresh.goto(fixtureUrl);
  await expect(fresh.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(fresh);
  await fresh.getByRole('button', { name: 'Preview selection', exact: true }).click();
  await expect(fresh.getByText('A0 preview — not saved')).toBeVisible();
  await expect(fresh.locator('#akm-a0-probe pre')).toHaveText(await fresh.locator('#code-text').textContent() ?? '');
  expect(await library.evaluate(async () => (await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).library.total)).toBe(0);
  await library.getByRole('link', { name: 'Settings', exact: true }).click();
  await library.getByRole('button', { name: 'Disable ChatGPT and remove access' }).click();
  await expect(existing.locator('#akm-a0-probe')).toHaveCount(0);
  await expect(fresh.locator('#akm-a0-probe')).toHaveCount(0);
  // This fixture's required host cannot be removed; native optional grant/revoke
  // remains a manual gate against the unchanged production manifest.
  expect(await sw.evaluate(() => chrome.storage.local.get('chatgptProbeEnabled'))).toEqual({ chatgptProbeEnabled: false });
  expect(await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
});

test('[authorized fixture] SPA route race rejects a frozen selection before asynchronous authorization returns', async () => {
  await enable();
  const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(page);
  // Capture-phase listener runs before the probe click; changes route while its
  // pointerdown-frozen selection is awaiting the permission round trip.
  await page.evaluate(() => {
    document.getElementById('akm-a0-probe')!.addEventListener('click', () => {
      history.pushState({}, '', '/c/different-conversation');
    }, { capture: true, once: true });
  });
  await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
  await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
  expect(await library.evaluate(async () => (await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ListNotes', offset: 0 })).library.total)).toBe(0);
});

test('[authorized fixture] rapid A to B to A navigation invalidates the original selection intent', async () => {
  await enable();
  const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  await selectCode(page);
  await page.evaluate(() => {
    document.getElementById('akm-a0-probe')!.addEventListener('click', () => {
      history.pushState({}, '', '/c/different-conversation');
      history.pushState({}, '', '/c/synthetic-a0');
    }, { capture: true, once: true });
  });
  await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
  await expect(page.getByText(/Preview unavailable: NAVIGATION_CHANGED/)).toBeVisible();
  await expect(page.locator('#akm-a0-probe pre')).toHaveCount(0);
});

test('[authorized fixture] sender allowlist denies content-script settings/read commands and page bridges', async () => {
  await enable();
  const page = await context.newPage(); await page.goto(fixtureUrl);
  await expect(page.locator('#akm-a0-probe')).toHaveCount(1);
  const [tab] = await sw.evaluate(() => chrome.tabs.query({ url: ['https://chatgpt.com/*'] }));
  const result = await sw.evaluate(async tabId => {
    const results = await chrome.scripting.executeScript({ target: { tabId: tabId!, frameIds: [0] }, func: async () => {
      const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetStatus' });
      let settingsReadable = true;
      try { await chrome.storage.local.get(null); } catch { settingsReadable = false; }
      return { reply, settingsReadable };
    } });
    return results[0]!.result;
  }, tab!.id);
  expect(result).toEqual({ reply: { ok: false, code: 'UNAUTHORIZED_CONTEXT' }, settingsReadable: false });
  const privateCommands = await sw.evaluate(async tabId => {
    const results = await chrome.scripting.executeScript({ target: { tabId: tabId!, frameIds: [0] }, func: async () => {
      const id = crypto.randomUUID();
      return Promise.all([
        { type: 'ListNotes', offset: 0 },
        { type: 'GetNote', generation: id, noteId: id, historyOffset: 0 },
        { type: 'GetNoteRevision', generation: id, noteId: id, version: 1 },
        { type: 'SaveManualNote', generation: id, requestId: id, issuedAt: new Date().toISOString(), noteId: null, expectedRecordVersion: null,
          fields: { title: '', bodyMarkdown: 'forged', type: 'personal_note', tags: [], personalExplanation: '', applicableVersion: '', reviewAfter: null } },
        { type: 'ExportLibrary' }, { type: 'DeleteNote', noteId: id },
      ].map(command => chrome.runtime.sendMessage({ protocolVersion: 1, ...command })));
    } });
    return results[0]!.result as { ok: boolean; code: string }[];
  }, tab!.id);
  expect(privateCommands.slice(0, 4).map(reply => reply.code)).toEqual(Array(4).fill('UNAUTHORIZED_CONTEXT'));
  expect(privateCommands.every(reply => !reply.ok)).toBe(true);
  await page.evaluate(() => window.postMessage({ type: 'PreviewSelection' }, '*'));
  await page.evaluate(() => window.postMessage({ protocolVersion: 1, type: 'ListNotes', offset: 0 }, '*'));
  await expect(page.getByText('A0 preview — not saved')).toHaveCount(0);
});

test('manifest and command bindings expose only the planned A0 capabilities', async () => {
  const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  expect(manifest.permissions).not.toContain('tabs');
  expect(manifest.optional_host_permissions).toEqual(['https://chatgpt.com/*']);
  expect(await sw.evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({ openPanelOnActionClick: true });
  const commands = await sw.evaluate(() => chrome.commands.getAll());
  expect(commands.find(command => command.name === 'open-recall')?.shortcut).toBe('Alt+Shift+K');
  expect(commands.find(command => command.name === 'preview-selection')?.shortcut).toBe('Alt+Shift+Y');
  await library.setViewportSize({ width: 360, height: 800 });
  expect(await library.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await library.screenshot({ path: 'artifacts/a0-library-360.png', fullPage: true });
});

test('a user gesture opens a real side-panel context', async () => {
  await library.getByRole('button', { name: 'Open recall panel' }).click();
  await expect.poll(() => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] })).length)).toBe(1);
});
