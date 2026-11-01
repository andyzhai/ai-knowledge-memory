import { describe, expect, it } from 'vitest';
import { parseManagement } from '../../src/shared/management';

const intent = { protocolVersion: 1, generation: crypto.randomUUID(), requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId: crypto.randomUUID(), expectedRecordVersion: 1 };
describe('curation and deletion command boundary', () => {
  it('accepts explicit review decisions and rejects ambiguous replacement links', () => {
    const review = { ...intent, type: 'ReviewNote', state: 'endorsed', supersededById: null };
    expect(parseManagement(review)).toEqual(review);
    for (const invalid of [
      { ...review, state: 'superseded' }, { ...review, supersededById: crypto.randomUUID() }, { ...review, state: 'automatic' },
      { ...review, expectedRecordVersion: 0 }, { ...review, alsoDelete: true }, { ...review, generation: 'stale' },
    ]) expect(parseManagement(invalid)).toBeNull();
  });
  it('requires a bounded exact source quote and rejects external or arbitrary source payloads', () => {
    const add = { ...intent, type: 'AddNoteSource', source: { kind: 'archive', captureId: crypto.randomUUID(), revisionId: crypto.randomUUID(), quote: 'Exact 🧠 quote' } };
    expect(parseManagement(add)).toEqual(add);
    for (const invalid of [
      { ...add, source: { ...add.source, quote: '' } }, { ...add, source: { ...add.source, quote: 'x'.repeat(262145) } },
      { ...add, source: { ...add.source, url: 'https://example.test/' } }, { ...add, source: { kind: 'existing', sourceId: 'unknown' } },
    ]) expect(parseManagement(invalid)).toBeNull();
  });
  it('requires an explicit deletion scope, strict filter dates and canonical sequence at confirmation', () => {
    const p = { protocolVersion: 1, type: 'PreviewDeletion', generation: intent.generation, target: { kind: 'all' } };
    expect(parseManagement(p)).toEqual(p);
    expect(parseManagement({ ...p, target: { kind: 'archive_filter', provider: 'chatgpt', through: '2026-02-30' } })).toBeNull();
    expect(parseManagement({ ...p, target: { kind: 'conversation', conversationId: intent.noteId } })).toBeNull();
    const { noteId: _id, expectedRecordVersion: _version, ...base } = intent;
    const c = { ...base, type: 'DeleteLibraryData', expectedDataSeq: 0, target: { kind: 'note', noteId: intent.noteId } };
    expect(parseManagement(c)).toEqual(c);
    expect(parseManagement({ ...c, expectedDataSeq: -1 })).toBeNull();
    expect(parseManagement({ ...c, target: { kind: 'all', uncheckedIds: [intent.noteId] } })).toBeNull();
  });
});
