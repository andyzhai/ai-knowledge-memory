import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type * as Probe from '../../src/capture/selection';
declare global { interface Window { SelectionProbe: typeof Probe } }

async function select(page: Page, startId: string, start = 0, endId = startId, end?: number) {
  await page.evaluate(({ startId, start, endId, end }) => {
    const first = document.getElementById(startId)!.firstChild!;
    const last = document.getElementById(endId)!.firstChild!;
    const range = document.createRange();
    range.setStart(first, start); range.setEnd(last, end ?? last.textContent!.length);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  }, { startId, start, endId, end });
}
async function snapshot(page: Page) {
  return page.evaluate(() => window.SelectionProbe.freezeSelection(getSelection(), 'https://chatgpt.com/c/synthetic-a0'));
}
test.beforeEach(async ({ page }) => {
  await page.setContent(await readFile('tests/fixtures/chatgpt-synthetic.html', 'utf8'));
  await page.addScriptTag({ path: resolve('.cache/test-probe/selection.js') });
});

test('code indentation and exact rendered selection survive focus loss', async ({ page, browser }, testInfo) => {
  await testInfo.attach('browser-version', { body: browser.version(), contentType: 'text/plain' });
  await select(page, 'code-text');
  const expected = await page.locator('#code-text').textContent();
  const renderedSelection = await page.evaluate(() => getSelection()!.toString());
  const frozen = await snapshot(page);
  await page.getByRole('button', { name: 'Move focus' }).click();
  expect(frozen.selectedText).toBe(renderedSelection);
  // Browser Selection.toString() omits a final visual newline; the source
  // fragment must independently retain the exact range's code text.
  expect(frozen.fragments[0]?.exactText).toBe(expected);
  expect(frozen.completion).toBe('unknown');
  expect(frozen.historyCoverage).toBe('unknown');
});

test('cross-message selection preserves ordered role/identity fragments', async ({ page }) => {
  await select(page, 'user-text', 8, 'answer-text', 11);
  const rendered = await page.evaluate(() => getSelection()!.toString());
  const result = await snapshot(page);
  expect(result.selectedText).toBe(rendered);
  expect(result.fragments.map(f => f.role)).toEqual(['user', 'assistant']);
  expect(result.fragments.map(f => f.sourceMessageId)).toEqual(['u1', 'a1']);
  expect(result.fragments[0]?.exactText).toBe('HT-928 🧠 中文.');
  expect(result.fragments[1]?.exactText).toBe('Start 🧠 中文');
});

test('emoji and Chinese use code-point offsets, repeated quotes keep occurrence', async ({ page }) => {
  await select(page, 'answer-text', 9, 'answer-text', 11);
  expect((await snapshot(page)).fragments[0]).toMatchObject({ exactText: '中文', startCodePoint: 8, endCodePoint: 10 });
  await select(page, 'repeat-one'); const first = await snapshot(page);
  await select(page, 'repeat-two'); const second = await snapshot(page);
  expect(first.fragments[0]?.exactText).toBe(second.fragments[0]?.exactText);
  expect(first.fragments[0]?.startCodePoint).not.toBe(second.fragments[0]?.startCodePoint);
});

test('composer, controls, hidden text and unknown layouts fail closed', async ({ page }) => {
  for (const selector of ['[contenteditable]', 'article button', 'article [hidden]', 'nav']) {
    const error = await page.evaluate(selector => {
      const element = document.querySelector(selector)!;
      const range = document.createRange(); range.selectNodeContents(element);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      try { window.SelectionProbe.freezeSelection(getSelection(), 'https://chatgpt.com/c/synthetic-a0'); return null; }
      catch (e) { return (e as Error).message; }
    }, selector);
    expect(error).toMatch(/EXCLUDED_CONTENT|ADAPTER_MISMATCH/);
  }
});

test('streaming and edited DOM cannot alter a frozen excerpt', async ({ page }) => {
  await select(page, 'stream-text'); const before = await snapshot(page);
  await page.locator('#stream-text').evaluate(node => { node.textContent = 'A complete rewritten answer'; });
  expect(before.selectedText).toBe('An unfinished answer');
  expect(before.completion).toBe('unknown');
  await select(page, 'stream-text');
  expect((await snapshot(page)).selectedText).toBe('A complete rewritten answer');
});

test('missing message boundaries never invent a role or source', async ({ page }) => {
  await page.locator('article').evaluateAll(nodes => nodes.forEach(node => node.removeAttribute('data-message-author-role')));
  await select(page, 'answer-text');
  await expect(snapshot(page)).rejects.toThrow('ADAPTER_MISMATCH');
});

test('explicit message metadata works without a main tag and with element range endpoints', async ({ page }) => {
  await page.evaluate(() => {
    const main = document.querySelector('main')!;
    const container = document.createElement('div');
    container.setAttribute('role', 'main');
    container.append(...main.childNodes); main.replaceWith(container);
    const message = document.querySelector('[data-message-id="a2"]')!;
    const range = document.createRange(); range.selectNodeContents(message);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  expect(await page.evaluate(() => window.SelectionProbe.eligibleSelection(getSelection()))).toBe(true);
  const result = await snapshot(page);
  expect(result.selectedText).toBe('An unfinished answer');
  expect(result.fragments).toEqual([{ role: 'assistant', sourceMessageId: 'a2', exactText: 'An unfinished answer', startCodePoint: 0, endCodePoint: 20, kind: 'text' }]);
});

test('layout-independent matching retains exclusions and rejects nested message boundaries', async ({ page }) => {
  await page.locator('nav').evaluate(node => node.setAttribute('data-message-author-role', 'assistant'));
  await page.locator('nav').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  expect(await page.evaluate(() => window.SelectionProbe.eligibleSelection(getSelection()))).toBe(false);
  await expect(snapshot(page)).rejects.toThrow('EXCLUDED_CONTENT');
  await page.locator('#answer-text').evaluate(node => node.setAttribute('data-message-author-role', 'assistant'));
  await select(page, 'answer-text');
  expect(await page.evaluate(() => window.SelectionProbe.eligibleSelection(getSelection()))).toBe(false);
  await expect(snapshot(page)).rejects.toThrow('ADAPTER_MISMATCH');
});

test('oversized selection is rejected rather than truncated', async ({ page }) => {
  await page.locator('#answer-text').evaluate(node => { node.textContent = '中'.repeat(100_000); });
  await select(page, 'answer-text');
  await expect(snapshot(page)).rejects.toThrow('PAYLOAD_TOO_LARGE');
});

test('observed ChatGPT selection containers map DIL text to the message identity, not the renderer', async ({ page }) => {
  await page.setContent(await readFile('tests/fixtures/chatgpt-current-structure.html', 'utf8'));
  expect(await page.locator('[data-message-author-role]').count()).toBe(0);
  await select(page, 'answer-text', 9, 'answer-text', 11);
  expect(await page.evaluate(() => window.SelectionProbe.eligibleSelection(getSelection()))).toBe(true);
  expect((await snapshot(page)).fragments).toEqual([{ role: 'assistant', sourceMessageId: 'observed-assistant', exactText: '中文', startCodePoint: 8, endCodePoint: 10, kind: 'text' }]);
  await select(page, 'code-text');
  const selected = await page.evaluate(() => getSelection()!.toString());
  const result = await snapshot(page);
  expect(result.selectedText).toBe(selected);
  expect(result.fragments[0]?.exactText).toBe(await page.locator('#code-text').textContent());
  expect(result.fragments[0]?.sourceMessageId).toBe('observed-assistant');
  await page.locator('[data-chatgpt-selection-message-id]').evaluate(node => node.removeAttribute('data-chatgpt-selection-message-id'));
  await expect(snapshot(page)).rejects.toThrow('ADAPTER_MISMATCH');
});

test('observed user bubbles support exact selections without inventing identity or nested duplicates', async ({ page }) => {
  await page.setContent(await readFile('tests/fixtures/chatgpt-user-bubbles.html', 'utf8'));
  await select(page, 'user-text');
  const read = () => page.evaluate(() => window.SelectionProbe.freezeSelection(getSelection(), 'https://chatgpt.com/g/synthetic-project/c/bubble-test'));
  expect((await read()).fragments).toEqual([{ role: 'user', sourceMessageId: null, kind: 'text', exactText: 'Explain ORACLE-QUESTION-731 🧠 中文.', startCodePoint: 0, endCodePoint: 33 }]);
  await select(page, 'followup-text');
  expect((await read()).fragments.map(f => f.role)).toEqual(['user']);
  // Existing explicit roots remain the boundary when they wrap a user bubble.
  await page.locator('#question-one').evaluate(node => {
    node.parentElement!.setAttribute('data-message-author-role', 'user');
    node.parentElement!.setAttribute('data-message-id', 'legacy-user');
  });
  await select(page, 'user-text');
  expect((await read()).fragments[0]).toMatchObject({ role: 'user', sourceMessageId: 'legacy-user' });
  await page.locator('#question-two').evaluate(node => { node.firstElementChild!.setAttribute('data-markdown-text-style', 'assistant-message'); });
  await select(page, 'followup-text');
  expect((await read()).fragments[0]!.role).toBe('unknown');
  expect((await read()).warnings).toContain('role_unknown');
  await page.locator('#question-two').evaluate(node => {
    node.firstElementChild!.removeAttribute('data-markdown-text-style');
    node.setAttribute('data-markdown-text-style', 'assistant-message');
  });
  expect((await read()).fragments[0]!.role).toBe('unknown');
});
