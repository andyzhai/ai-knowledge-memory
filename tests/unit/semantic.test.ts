import { describe, expect, it } from 'vitest';
import { chunkNote, fuseResults, normalizedVector, SemanticIndex } from '../../src/search/semantic';
import { createKnowledgeIndex } from '../../src/search/lexical';
import { createSemanticWorkerHandler } from '../../src/search/semantic-worker-state';
import { verifyModelAsset } from '../../src/search/asset-integrity';
import { EMBEDDING_SIGNATURE, type EmbeddingProvider, type SemanticReply } from '../../src/shared/semantic';
import { SEARCH_POLICY_VERSION, type SearchDocument } from '../../src/shared/search';
import type { KnowledgeItem } from '../../src/shared/knowledge';

function doc(id: string, text: string, fields: Partial<KnowledgeItem> = {}): SearchDocument {
  return { providers: ['manual'], note: { id, plainText: text, bodyMarkdown: text, title: '', tags: [], personalExplanation: '', applicableVersion: '',
    type: 'reference', reviewState: 'saved', reviewedAt: null, reviewAfter: null, supersededById: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', recordVersion: 1,
    schemaVersion: 1, canonicalVersion: 1, currentVersion: 1, contentHash: `hash-${id}`, origin: 'manual_note', sourceKind: 'manual',
    curationKey: null, createdByRequestId: id, ...fields } };
}
const marker = { generation: 'one', dataSeq: 1, policyVersion: SEARCH_POLICY_VERSION };
const provider: EmbeddingProvider = { signature: EMBEDDING_SIGNATURE, dimensions: 2, tokenCount: text => Array.from(text).length + 2,
  embed: async text => text.includes('needle') ? [1, 0] : [0, 1] };

describe('H derived retrieval invariants', () => {
  it('preserves all Unicode/code source offsets, splitting long lines without truncation', () => {
    const document = doc('long', ('🧠中文\n```ts\n  const a = 1;\n```\n\n').repeat(200), { title: 'Title', personalExplanation: 'My explanation', tags: ['one', 'two'] });
    const chunks = chunkNote(document, provider.tokenCount);
    expect(chunks.map(chunk => chunk.text).join('')).toBe([document.note.title, document.note.plainText, document.note.personalExplanation, document.note.tags.join('\n')].join('\n\n'));
    for (const chunk of chunks) {
      expect(provider.tokenCount(chunk.text)).toBeLessThanOrEqual(128);
      for (const source of chunk.sources) {
        const original = source.field === 'tags' ? document.note.tags.join('\n') : document.note[source.field];
        const actual = Array.from(chunk.text).slice(source.offset + source.start - chunk.start, source.offset + source.end - chunk.start).join('');
        expect(actual).toBe(Array.from(original).slice(source.start, source.end).join(''));
      }
    }
    expect(chunkNote(doc('short', 'short note'), provider.tokenCount)).toHaveLength(1);
  });
  it('rejects invalid dimensions, non-finite values and zero vectors', () => {
    for (const values of [[1], [1, NaN], [Infinity, 0], [0, 0]]) expect(() => normalizedVector(values, 2)).toThrow();
    expect(normalizedVector([3, 4], 2)).toEqual([0.6, 0.8]);
  });
  it('aggregates chunks once and applies every visibility filter before top-k', async () => {
    const index = new SemanticIndex();
    const target = doc('target', 'needle '.repeat(100), { tags: ['Keep'], reviewState: 'needs_review', reviewedAt: '2026-10-02T00:00:00.000Z' });
    await index.build([...Array.from({ length: 150 }, (_, i) => doc(`decoy${i}`, 'needle')), target, doc('old', 'needle', { reviewState: 'superseded' })], marker, provider);
    const result = await index.search('needle', { filters: { provider: 'manual', type: 'reference', tag: 'keep', reviewState: 'needs_review', dateField: 'reviewed', dateFrom: '2026-10-02', dateTo: '2026-10-02' } }, marker, provider);
    expect(result.hits.map(hit => hit.id)).toEqual(['target']);
    expect((await index.search('needle', { filters: { reviewState: 'superseded' } }, marker, provider)).total).toBe(0);
    expect((await index.search('needle', { filters: { includeOutdated: true, reviewState: 'superseded' } }, marker, provider)).total).toBe(1);
  });
  it('never publishes a delayed vector after simulated removal, generation change or edit', async () => {
    const index = new SemanticIndex(); let finish!: (vector: number[]) => void;
    const slow = { ...provider, embed: () => new Promise<number[]>(resolve => { finish = resolve; }) };
    const obsolete = index.build([doc('same', 'old')], marker, slow);
    await index.build([doc('same', 'fresh', { recordVersion: 2, contentHash: 'fresh' })], { ...marker, generation: 'two' }, provider);
    finish([1, 0]); expect(await obsolete).toBeNull();
    await expect(index.search('needle', {}, marker, provider)).rejects.toThrow('Stale');
    const fresh = await index.search('needle', {}, { ...marker, generation: 'two' }, provider);
    expect(fresh.hits[0]).toMatchObject({ recordVersion: 2, contentHash: 'fresh' });
    const late = index.search('needle', {}, { ...marker, generation: 'two' }, slow); index.clear(); finish([1, 0]);
    await expect(late).rejects.toThrow('Stale');
  });
  it('rejects mixed signatures and validates literal phrases in semantic suggestions', async () => {
    const index = new SemanticIndex(); await index.build([doc('a', 'needle same'), doc('b', 'needle other')], marker, provider);
    await expect(index.search('needle', {}, marker, { ...provider, signature: 'changed model' })).rejects.toThrow('Stale');
    expect((await index.search('"same"', {}, marker, provider)).hits.map(hit => hit.id)).toEqual(['a']);
    expect((await index.search('!!!', {}, marker, provider)).total).toBe(0);
    expect((await index.search('"open', {}, marker, provider)).error).toBeTruthy();
  });
  it('RRF protects exact order and counts each note only once per route', async () => {
    const documents = [doc('exact', 'HT-928'), doc('prefix', 'HT-9280'), doc('meaning', 'needle '.repeat(50))];
    const lexical = createKnowledgeIndex(documents).search('HT-928');
    const index = new SemanticIndex(); await index.build(documents, marker, provider);
    const semantic = await index.search('needle', {}, marker, provider);
    const fused = fuseResults(lexical, semantic);
    expect(fused.hits[0]?.id).toBe('exact');
    const duplicated = { ...semantic, hits: [semantic.hits[0]!, ...semantic.hits] };
    expect(fuseResults(lexical, duplicated).hits).toEqual(fused.hits);
    expect(new Set(fused.hits.map(hit => hit.id)).size).toBe(fused.hits.length);
  });
  it('exposes model failure separately and rejects the wrong worker signature', async () => {
    const replies: SemanticReply[] = [];
    const handle = createSemanticWorkerHandler(async () => { throw new Error('missing/corrupt'); }, reply => replies.push(reply));
    await handle({ type: 'build', buildId: 1, marker, signature: EMBEDDING_SIGNATURE, documents: [] });
    expect(replies.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('Lexical search remains available') });
    await handle({ type: 'build', buildId: 2, marker, signature: 'wrong', documents: [] });
    expect(replies.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('Incompatible') });
  });
  it('coalesces rapid queries and ignores a late query failure after a newer build', async () => {
    const replies: SemanticReply[] = [];
    let rejectOld!: (reason: Error) => void, delay = false;
    const deferred = { ...provider, embed: async (text: string) => delay && text === 'old query'
      ? new Promise<number[]>((_resolve, reject) => { rejectOld = reject; }) : provider.embed(text) };
    const handle = createSemanticWorkerHandler(async () => deferred, reply => replies.push(reply));
    await handle({ type: 'build', buildId: 1, marker, signature: EMBEDDING_SIGNATURE, documents: [doc('old', 'needle')] });
    delay = true;
    const oldQuery = handle({ type: 'search', queryId: 1, marker, signature: EMBEDDING_SIGNATURE, query: 'old query', options: {} });
    await handle({ type: 'build', buildId: 2, marker: { ...marker, dataSeq: 2 }, signature: EMBEDDING_SIGNATURE, documents: [doc('new', 'needle')] });
    await handle({ type: 'search', queryId: 2, marker: { ...marker, dataSeq: 2 }, signature: EMBEDDING_SIGNATURE, query: 'needle', options: {} });
    rejectOld(new Error('old inference failed')); await oldQuery;
    expect(replies.filter(reply => reply.type === 'error')).toEqual([]);
    expect(replies.filter(reply => reply.type === 'results')).toEqual([expect.objectContaining({ queryId: 2, result: expect.objectContaining({ hits: [expect.objectContaining({ id: 'new' })] }) })]);
  });
  it('verifies assets and rejects interrupted bytes and same-size corruption', async () => {
    const buffer = new TextEncoder().encode('abc').buffer;
    const file = { bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };
    await verifyModelAsset(buffer, file);
    await expect(verifyModelAsset(buffer.slice(0, 2), file)).rejects.toThrow('size');
    await expect(verifyModelAsset(new TextEncoder().encode('abd').buffer, file)).rejects.toThrow('checksum');
  });
});
