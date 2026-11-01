import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

let context: BrowserContext, library: Page, profile: string;
test.beforeEach(async () => {
  await mkdir('.cache/profiles', { recursive: true });
  profile = await mkdtemp(resolve('.cache/profiles/markdown-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  library = await context.newPage();
  await library.goto(`chrome-extension://${new URL(sw.url()).host}/library.html`);
  await expect(library.getByText('Local library ready.', { exact: true })).toBeVisible();
  await library.getByRole('button', { name: 'New note', exact: true }).click();
  await expect(library.getByLabel('Title (optional)')).toBeFocused();
});
test.afterEach(async () => {
  await context?.close();
  const child = relative(resolve('.cache/profiles'), resolve(profile));
  if (!child.startsWith('markdown-') || child.includes('..') || isAbsolute(child)) throw new Error('Unsafe profile cleanup');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function paste(formats: Record<string, string>) {
  // Explicit Markdown MIME types cannot be written by the web Clipboard API.
  // Dispatch the actual browser ClipboardEvent/DataTransfer shape for those.
  await library.getByLabel('Body (Markdown)').evaluate((input, formats) => {
    const clipboardData = new DataTransfer();
    for (const [type, value] of Object.entries(formats)) clipboardData.setData(type, value);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, formats);
}
async function nativePaste(formats: Record<string, string>) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await library.bringToFront();
  await library.evaluate(async formats => {
    await navigator.clipboard.write([new ClipboardItem(Object.fromEntries(Object.entries(formats).map(([type, value]) => [type, new Blob([value], { type })])))]);
  }, formats);
  await library.getByLabel('Body (Markdown)').focus();
  await library.keyboard.press('Control+V');
}
async function preview() {
  await library.getByRole('button', { name: 'Preview', exact: true }).click();
  return library.getByRole('region', { name: 'Markdown preview', exact: true });
}
async function saveReopen(expected: string) {
  await library.getByLabel('Title (optional)').fill('Markdown round trip');
  await library.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(library.locator('.note-reading')).toBeVisible();
  await library.reload();
  await expect(library.locator('.note-reading')).toBeVisible();
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue(expected);
}

const richHtml = `<div><h1>Heading one</h1><h2>Heading two</h2><h3>Heading three</h3><h4>Heading four</h4><h5>Heading five</h5><h6>Heading six</h6>
<p><strong>bold</strong>, <em>italic</em>, <del>removed</del> &amp; punctuation *literal* &lt;tag&gt;.</p>
<blockquote><p>A quotation<br>second line</p></blockquote>
<ol start="3"><li>Third<ul><li>Nested</li></ul></li><li>Fourth</li></ol>
<ul><li><input type="checkbox" checked disabled>Done</li><li><input type="checkbox" disabled>Later</li></ul>
<table><thead><tr><th>Name</th><th align="right">Value</th></tr></thead><tbody><tr><td><strong>Key</strong></td><td>42 | 43</td></tr></tbody></table>
<div><button>Copy code</button><pre><code class="language-ts">  const x = '&lt;tag&gt;';
\t// \`\`\` inside code
</code></pre></div>
<p><a href="https://example.com/guide?utm_source=chat">Guide</a> and <code>a\`b</code></p></div>`;

test('native formatted HTML paste renders GFM, previews and survives save/reopen', async () => {
  await nativePaste({ 'text/html': richHtml, 'text/plain': 'formatting would be lost here' });
  const markdown = await library.getByLabel('Body (Markdown)').inputValue();
  expect(markdown).toContain('# Heading one');
  expect(markdown).not.toContain('Copy code');
  const rendered = await preview();
  for (let level = 1; level <= 6; level++) await expect(rendered.getByRole('heading', { level })).toHaveCount(1);
  await expect(rendered.locator('strong')).toHaveText(['bold', 'Key']);
  await expect(rendered.locator('em')).toHaveText('italic');
  await expect(rendered.locator('del')).toHaveText('removed');
  await expect(rendered).toContainText('& punctuation *literal* <tag>.');
  await expect(rendered.locator('blockquote')).toContainText('A quotation');
  await expect(rendered.locator('blockquote br')).toHaveCount(1);
  await expect(rendered.locator('ol')).toHaveAttribute('start', '3');
  await expect(rendered.locator('ol ul li')).toHaveText('Nested');
  await expect(rendered.getByRole('checkbox', { name: 'Completed task' })).toBeChecked();
  await expect(rendered.getByRole('checkbox', { name: 'Incomplete task' })).not.toBeChecked();
  await expect(rendered.getByRole('checkbox').first()).toBeDisabled();
  await expect(rendered.locator('tbody td').last()).toHaveText('42 | 43');
  await expect(rendered.locator('thead th').last()).toHaveCSS('text-align', 'right');
  await expect(rendered.locator('pre code')).toHaveText("  const x = '<tag>';\n\t// ``` inside code");
  await expect(rendered.getByRole('link', { name: 'Guide' })).toHaveAttribute('href', 'https://example.com/guide');
  await expect(rendered.locator('p > code')).toHaveText('a`b');
  await library.setViewportSize({ width: 360, height: 800 });
  expect(await library.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await saveReopen(markdown); // Save directly while preview is active.
  const again = await preview();
  await expect(again.locator('table')).toHaveCount(1);
  await expect(again.locator('pre code')).toHaveText("  const x = '<tag>';\n\t// ``` inside code");
});

test('explicit Markdown wins and replaces only the selected text with the caret after it', async () => {
  const input = library.getByLabel('Body (Markdown)');
  await input.fill('before REPLACE after');
  await expect(input).toHaveValue('before REPLACE after');
  await input.evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(7, 14));
  const markdown = '**kept**\n\n- [x] done';
  await paste({ 'text/markdown': markdown, 'text/html': '<b>wrong</b>', 'text/plain': 'wrong' });
  await expect(input).toHaveValue(`before ${markdown} after`);
  await expect.poll(() => input.evaluate(input => (input as HTMLTextAreaElement).selectionStart)).toBe(7 + markdown.length);
  await saveReopen(`before ${markdown} after`);
});

test('native plain-text paste retains exact Markdown, Unicode and code whitespace', async () => {
  const plain = '# Plain 🧠\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```sh\n  echo "hi"  \n\t# exact\n```\n';
  await nativePaste({ 'text/plain': plain });
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue(plain);
  const rendered = await preview();
  await expect(rendered.locator('table')).toHaveCount(1);
  await expect(rendered.locator('pre code')).toHaveText('  echo "hi"  \n\t# exact');
  await library.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue(plain);
  await saveReopen(plain);
});

test('hostile clipboard HTML stays inert and makes no network requests', async () => {
  const requests: string[] = [];
  context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const dialogs: string[] = [];
  library.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await paste({ 'text/html': `<script>alert('script')</script><style>@import 'https://evil.test/css';</style>
    <img src="https://evil.test/image" onerror="alert('image')"><iframe src="https://evil.test/frame"></iframe>
    <svg onload="alert('svg')"></svg><object data="https://evil.test/object"></object>
    <p onclick="alert('click')">Safe <a href="javascript:alert(1)">bad link</a></p><x-hostile>text</x-hostile>`, 'text/plain': 'fallback' });
  await expect(library.getByLabel('Body (Markdown)')).toHaveValue('Safe bad link\n\ntext');
  const rendered = await preview();
  await expect(rendered).toContainText('Safe bad link');
  await expect(rendered.locator('script,style,img,iframe,svg,object,a')).toHaveCount(0);
  await saveReopen('Safe bad link\n\ntext');
  expect(dialogs).toEqual([]);
  expect(requests).toEqual([]);
});

test('empty, unsupported and excessive HTML falls back to plain text', async () => {
  for (const html of ['<script>alert(1)</script>', '<!-- empty -->', '<div>'.repeat(70) + 'deep' + '</div>'.repeat(70), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    await library.getByLabel('Body (Markdown)').fill('');
    await paste({ 'text/html': html, 'text/plain': '  plain fallback\n' });
    await expect(library.getByLabel('Body (Markdown)')).toHaveValue('  plain fallback\n');
  }
});

test('headerless tables, escaped syntax and nested quotes convert to readable Markdown', async () => {
  await paste({ 'text/html': '<table><tr><td>first</td><td><code>a|b</code></td></tr></table><blockquote><blockquote><p>inner</p></blockquote></blockquote><p>1. literal &amp;amp; [brackets] \\ slash</p>' });
  const rendered = await preview();
  await expect(rendered.locator('tbody tr')).toHaveCount(1);
  await expect(rendered.locator('td code')).toHaveText('a|b');
  await expect(rendered.locator('blockquote blockquote')).toHaveText('inner');
  await expect(rendered).toContainText('1. literal &amp; [brackets] \\ slash');
});
