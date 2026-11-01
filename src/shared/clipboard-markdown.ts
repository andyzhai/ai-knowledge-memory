import { safeLink } from './markdown';

// Plain text and explicit Markdown are never rewritten. HTML conversion is a
// browser-only boundary; the result is still the same bodyMarkdown string.
export function clipboardMarkdown(clipboard: Pick<DataTransfer, 'getData'>, convert = htmlToMarkdown): string {
  for (const type of ['text/markdown', 'text/x-markdown']) {
    const markdown = clipboard.getData(type);
    if (markdown) return markdown;
  }
  const html = clipboard.getData('text/html');
  if (html) {
    try {
      const markdown = convert(html);
      if (markdown.trim()) return markdown;
    } catch { /* Unsupported or excessive HTML falls back to plain text. */ }
  }
  return clipboard.getData('text/plain');
}

const escapeText = (text: string) => text.replace(/[\\`*_{}\[\]()#+.!|>~<&-]/g, '\\$&');
const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'LINK', 'META', 'BASE', 'BUTTON', 'SELECT', 'TEXTAREA']);
const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD']);

export function htmlToMarkdown(html: string): string {
  // A template in a detached document is inert: no scripts, custom elements,
  // images or frames run/load. Never attach these nodes to the live document.
  if (html.length > 2 * 1024 * 1024) throw new Error('Clipboard HTML too large');
  const template = document.implementation.createHTMLDocument('').createElement('template');
  template.innerHTML = html;
  let visited = 0;
  function children(node: Node, depth: number): string {
    return Array.from(node.childNodes, child => visit(child, depth + 1)).join('');
  }
  function visit(node: Node, depth: number): string {
    if (depth > 64 || ++visited > 50_000) throw new Error('Clipboard HTML too complex');
    if (node.nodeType === 3) return escapeText((node.textContent ?? '').replace(/\s+/g, ' '));
    if (node.nodeType !== 1) return '';
    const element = node as Element;
    const tag = element.tagName;
    if (ignored.has(tag) || element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return '';
    if (tag === 'PRE') {
      // Ignore code-block toolbars; preserve whitespace and literal backticks.
      const code = element.querySelector('code') ?? element;
      const text = code.textContent ?? '';
      const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
      const language = code.getAttribute('class')?.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? '';
      return `\n\n${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    }
    if (tag === 'CODE') {
      const text = (element.textContent ?? '').replace(/\n/g, ' ');
      const fence = '`'.repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
      const pad = /^`|`$|^ .* $/s.test(text) ? ' ' : '';
      return `${fence}${pad}${text}${pad}${fence}`;
    }
    if (tag === 'BR') return '  \n';
    if (tag === 'HR') return '\n\n---\n\n';
    if (tag === 'INPUT') return element.getAttribute('type') === 'checkbox' ? (element.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';
    if (tag === 'IMG') return escapeText(element.getAttribute('alt') ?? '');
    if (tag === 'UL' || tag === 'OL') {
      const start = Number(element.getAttribute('start') ?? 1);
      const items = Array.from(element.children).filter(child => child.tagName === 'LI');
      return '\n\n' + items.map((item, i) => {
        const marker = tag === 'OL' ? `${Number.isSafeInteger(start) && start >= 0 ? start + i : i + 1}. ` : '- ';
        const content = children(item, depth).trim();
        return marker + content.replace(/\n/g, '\n' + ' '.repeat(marker.length));
      }).join('\n') + '\n\n';
    }
    if (tag === 'TABLE') {
      const rows = Array.from(element.querySelectorAll('tr')).filter(row => row.closest('table') === element);
      const cells = rows.map(row => Array.from(row.children).filter(cell => /^(TH|TD)$/.test(cell.tagName)));
      const width = Math.max(0, ...cells.map(row => row.length));
      if (!width) return '';
      // GFM has one header row and no merged cells. A headerless table gets an
      // empty header; complex cell contents are flattened to readable text.
      const cellText = (cell: Element) => children(cell, depth).trim().replace(/\s*\n\s*/g, ' ').replace(/(?<!\\)\|/g, '\\|');
      const line = (row: Element[]) => '| ' + Array.from({ length: width }, (_, i) => row[i] ? cellText(row[i]!) : '').join(' | ') + ' |';
      const header = cells[0]?.some(cell => cell.tagName === 'TH') ? cells.shift()! : [];
      const separator = Array.from({ length: width }, (_, i) => {
        const alignment = header[i]?.getAttribute('align') ?? header[i]?.getAttribute('style')?.match(/text-align:\s*(left|center|right)/i)?.[1];
        return alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : alignment === 'left' ? ':---' : '---';
      });
      return '\n\n' + [line(header), '| ' + separator.join(' | ') + ' |', ...cells.map(line)].join('\n') + '\n\n';
    }
    const content = children(element, depth);
    if (/^H[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${content.trim()}\n\n`;
    if (tag === 'BLOCKQUOTE') return '\n\n' + content.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    if (blocks.has(tag) || tag === 'LI') return `\n\n${content.trim()}\n\n`;
    if (['STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'STRIKE'].includes(tag)) {
      const marker = tag === 'STRONG' || tag === 'B' ? '**' : tag === 'EM' || tag === 'I' ? '*' : '~~';
      return content.trim() ? content.replace(/^(\s*)([\s\S]*?)(\s*)$/, `$1${marker}$2${marker}$3`) : content;
    }
    if (tag === 'A') {
      const href = safeLink(element.getAttribute('href') ?? '');
      return href ? `[${content}](<${href.replace(/</g, '%3C').replace(/>/g, '%3E')}>)` : content;
    }
    // Unknown layout wrappers retain their text, never attributes or raw HTML.
    return content;
  }
  return children(template.content, 0).trim();
}
