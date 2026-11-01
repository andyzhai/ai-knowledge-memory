import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeMarkdown } from '../../src/ui/SafeMarkdown';
import { clipboardMarkdown } from '../../src/shared/clipboard-markdown';
import { markdownPlainText } from '../../src/shared/markdown';

const render = (body: string) => renderToStaticMarkup(createElement(SafeMarkdown, { body }));
const clipboard = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? '' });

describe('GFM rendering', () => {
  it('preserves heading levels, table alignment and inline formatting', () => {
    for (let level = 1; level <= 6; level++) expect(render(`${'#'.repeat(level)} Heading`)).toContain(`<h${level}>Heading</h${level}>`);
    const output = render('| Name | Value |\n| :--- | ---: |\n| **bold** | ~~old~~ and `code` |');
    expect(output).toContain('<table>');
    expect(output).toContain('<th scope="col" style="text-align:left">Name</th>');
    expect(output).toContain('<td style="text-align:right"><del>old</del> and <code>code</code></td>');
    expect(output).toContain('<strong>bold</strong>');
  });
  it('renders nested lists, task states, ordered starts, quotes and exact code', () => {
    const output = render('3. third\n   - nested\n\n- [x] done\n- [ ] todo\n\n> *quote*\n\n```ts\n  const x = "<tag>";\n\t// exact\n```');
    expect(output).toContain('<ol start="3">');
    expect(output).toContain('<ul><li>nested</li></ul>');
    expect(output).toMatch(/type="checkbox"[^>]*disabled=""[^>]*checked=""/);
    expect(output.match(/type="checkbox"/g)).toHaveLength(2);
    expect(output).toContain('aria-label="Incomplete task"');
    expect(output).toContain('<blockquote><p><em>quote</em></p>');
    expect(output).toContain('  const x = &quot;&lt;tag&gt;&quot;;\n\t// exact');
  });
  it('keeps HTML and unsafe links inert inside newly supported structures', () => {
    const output = render('| Payload |\n| --- |\n| <img src=x onerror=alert(1)> [bad](javascript:alert%281%29) |\n\n- [x] <script>alert(1)</script>');
    expect(output).not.toMatch(/<img|<script|href="javascript:/);
    expect(output).toContain('link disabled');
    expect(output).toContain('&lt;img');
    expect(markdownPlainText('| Term |\n| --- |\n| searchable |')).toContain('searchable');
  });
});

describe('clipboard format priority', () => {
  it.each(['text/markdown', 'text/x-markdown'])('prefers exact %s over HTML and plain text', type => {
    const convert = vi.fn();
    const markdown = '# Keep\n\n```\n  exact  \n```\n';
    expect(clipboardMarkdown(clipboard({ [type]: markdown, 'text/html': '<b>other</b>', 'text/plain': 'other' }), convert)).toBe(markdown);
    expect(convert).not.toHaveBeenCalled();
  });
  it('uses converted HTML before plain text', () => {
    const convert = vi.fn(() => '**bold**');
    expect(clipboardMarkdown(clipboard({ 'text/html': '<b>bold</b>', 'text/plain': 'bold' }), convert)).toBe('**bold**');
    expect(convert).toHaveBeenCalledWith('<b>bold</b>');
  });
  it('preserves plain text exactly, including on empty or failed HTML conversion', () => {
    const plain = '  plain\n\t🧠 **literal source**\n';
    expect(clipboardMarkdown(clipboard({ 'text/plain': plain }))).toBe(plain);
    for (const convert of [() => ' ', () => { throw new Error('unsupported'); }]) {
      expect(clipboardMarkdown(clipboard({ 'text/html': '<div></div>', 'text/plain': plain }), convert)).toBe(plain);
    }
    expect(clipboardMarkdown(clipboard({}))).toBe('');
  });
});
