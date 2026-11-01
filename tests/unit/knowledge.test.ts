import { describe, expect, it } from 'vitest';
import { canonicalJson, digest, parseLibraryCommand, MAX_NOTE_BYTES, type NoteFields } from '../../src/shared/knowledge';
import { sourceHash, validAnchor } from '../../src/shared/archive';
import { markdownPlainText, safeLink } from '../../src/shared/markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createHash } from 'node:crypto';
import { SafeMarkdown } from '../../src/ui/SafeMarkdown';

const fields: NoteFields = { title: '', bodyMarkdown: 'A🧠中文\n\n```sh\n  echo "hi"  \n\t# exact\n```', type: 'personal_note', tags: [], personalExplanation: '', applicableVersion: '', reviewAfter: null };
const command = { protocolVersion: 1, type: 'SaveManualNote', requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), generation: crypto.randomUUID(), noteId: null, expectedRecordVersion: null, fields };
describe('canonical note boundary', () => {
  it('accepts exact text and rejects malformed envelopes, fields, enums, dates and limits', () => {
    expect(parseLibraryCommand(command)).toEqual(command);
    for (const bad of [null, { ...command, extra: true }, { ...command, protocolVersion: 2 }, { ...command, noteId: crypto.randomUUID() }, { ...command, issuedAt: 'yesterday' }, { ...command, requestId: '__proto__' },
      ...[{ bodyMarkdown: ' ' }, { bodyMarkdown: '🧠'.repeat(MAX_NOTE_BYTES / 4 + 1) }, { bodyMarkdown: '\ud800' }, { type: 'unknown' }, { reviewState: 'endorsed' }, { tags: ['same', 'same'] }, { tags: [' leading'] }, { reviewAfter: '2026-02-30' }].map(change => ({ ...command, fields: { ...fields, ...change } }))]) expect(parseLibraryCommand(bad)).toBeNull();
  });
  it('uses versioned SHA-256, stable key ordering and exact whitespace, role and scope', async () => {
    expect(canonicalJson({ b: 2, a: ['x', null] })).toBe('{"a":["x",null],"b":2}');
    expect(await digest({ b: 2, a: 1 })).toBe(await digest({ a: 1, b: 2 }));
    expect(await digest('abc')).toBe(createHash('sha256').update('{"canonicalVersion":1,"value":"abc"}').digest('hex'));
    for (const value of [undefined, NaN, { a: undefined }]) expect(() => canonicalJson(value)).toThrow();
    const blocks = [{ kind: 'code' as const, text: '  a\n\tb  ', language: null }];
    const hash = await sourceHash('excerpt', 'assistant', blocks);
    expect(hash).not.toBe(await sourceHash('message', 'assistant', blocks));
    expect(hash).not.toBe(await sourceHash('excerpt', 'user', blocks));
    expect(hash).not.toBe(await sourceHash('excerpt', 'assistant', [{ ...blocks[0]!, text: 'a\nb' }]));
    expect(await digest('é')).not.toBe(await digest('e\u0301'));
    expect(markdownPlainText(fields.bodyMarkdown)).toContain('  echo "hi"  \n\t# exact');
  });
  it('checks code-point source anchors without splitting emoji or changing text', () => {
    expect(validAnchor('A🧠中文', { quote: '🧠中', start: 1, end: 3, extractorVersion: '1' })).toBe(true);
    expect(validAnchor('A🧠中文', { quote: '🧠中', start: 1, end: 4, extractorVersion: '1' })).toBe(false);
  });
});
describe('safe Markdown', () => {
  it('renders code and Markdown with raw HTML inert and images disabled', () => {
    const output = renderToStaticMarkup(createElement(SafeMarkdown, { body: '# Hello\n\n**bold**\n\n<script>alert(1)</script>\n\n![secret](https://evil.test/image)\n\n[bad](javascript:alert(1))\n\n```sh\n  a  \n\tb\n```' }));
    expect(output).toContain('<strong>bold</strong>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).not.toMatch(/<script|<img|javascript:/);
    expect(output).toContain('  a  \n\tb');
  });
  it('allows only explicit isolated HTTP(S) links and strips known trackers', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/relative', '//evil.test', 'chrome://settings', 'https://name:password@site.test', 'https://site.test/?token=secret', 'https://site.test/?X-Amz-Signature=x', 'https://si\nte.test']) expect(safeLink(url)).toBeNull();
    expect(safeLink('https://example.com/a?utm_source=x&q=one#part')).toBe('https://example.com/a?q=one#part');
    const output = renderToStaticMarkup(createElement(SafeMarkdown, { body: '[safe](https://example.com)' }));
    expect(output).toContain('rel="noopener noreferrer"'); expect(output).toContain('referrerPolicy="no-referrer"');
  });
});
