import { expect, it } from 'vitest';
import { parseCurationCommand, validSnapshot, type SelectionSnapshot } from '../../src/shared/curation';
const snapshot: SelectionSnapshot = { sourceUrl: 'https://chatgpt.com/c/test', selectedText: '🧠中文', fragments: [{ role: 'assistant', sourceMessageId: 'm1', exactText: '🧠中文', kind: 'text', startCodePoint: 2, endCodePoint: 5 }],
  extractorVersion: 'a2-dom-text-1', temporaryStatus: 'unknown', historyCoverage: 'unknown', branchCoverage: 'observed_only', completion: 'unknown', warnings: ['experimental_selectors'] };
const command = { protocolVersion: 1, type: 'CurateSelection', requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), generation: crypto.randomUUID(), providerEpoch: crypto.randomUUID(), nonce: crypto.randomUUID(), snapshot };
it('accepts exact bounded selection envelopes and rejects fields not owned by the content adapter', () => {
  expect(parseCurationCommand(command)).toEqual(command);
  expect(validSnapshot({ ...snapshot, extractorVersion: 'a2-dom-text-2' })).toBe(true);
  expect(validSnapshot({ ...snapshot, extractorVersion: 'unrecognized-extractor' })).toBe(false);
  for (const bad of [{ ...command, tabId: 1 }, { ...command, nonce: 'forged' }, { ...command, generation: null }, { ...command, snapshot: { ...snapshot, title: 'unselected content' } }, { ...command, snapshot: { ...snapshot, sourceUrl: 'https://evil.test/c/test' } }]) expect(parseCurationCommand(bad)).toBeNull();
});
it('checks fragment enums, code-point length, known identity bounds and excluded metadata', () => {
  for (const change of [{ endCodePoint: 6 }, { startCodePoint: -1 }, { endCodePoint: Infinity }, { role: 'admin' }, { kind: 'html' }, { sourceMessageId: 'x'.repeat(257) }, { exactText: '\ud800' }, { html: '<script>' }]) {
    expect(validSnapshot({ ...snapshot, fragments: [{ ...snapshot.fragments[0], ...change }] })).toBe(false);
  }
  expect(validSnapshot({ ...snapshot, fragments: [{ ...snapshot.fragments[0], sourceMessageId: null, role: 'unknown' }] })).toBe(true);
});
it('rejects oversized, empty and over-fragmented selections rather than truncating', () => {
  expect(validSnapshot({ ...snapshot, selectedText: 'x'.repeat(256 * 1024) })).toBe(false);
  expect(validSnapshot({ ...snapshot, fragments: Array(33).fill(snapshot.fragments[0]) })).toBe(false);
  expect(validSnapshot({ ...snapshot, selectedText: ' ' })).toBe(false);
});
it('permits only bounded UI/scoped action envelopes', () => {
  const action = { protocolVersion: 1, type: 'UndoSelection', requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), generation: crypto.randomUUID(), savedRequestId: crypto.randomUUID(), expectedRecordVersion: 1 };
  expect(parseCurationCommand(action)).toEqual(action);
  expect(parseCurationCommand({ ...action, noteId: crypto.randomUUID() })).toBeNull();
  expect(parseCurationCommand({ ...action, expectedRecordVersion: 0 })).toBeNull();
});
