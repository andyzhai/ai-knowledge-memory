import { describe, expect, it } from 'vitest';
import { createKnowledgeIndex, parseQuery, tokenize } from '../../src/search/lexical';
import { createSearchWorkerHandler } from '../../src/search/worker-state';
import type { KnowledgeItem } from '../../src/shared/knowledge';
import { SEARCH_POLICY_VERSION, type SearchDocument, type SearchMarker, type SearchWorkerReply } from '../../src/shared/search';

function doc(id: string, plainText: string, fields: Partial<KnowledgeItem> = {}, providers: SearchDocument['providers'] = ['manual']): SearchDocument {
  return { providers, note: {
    id, plainText, title: '', bodyMarkdown: plainText, tags: [], personalExplanation: '', applicableVersion: '',
    type: 'reference', reviewState: 'saved', reviewedAt: null, reviewAfter: null, supersededById: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', recordVersion: 1,
    schemaVersion: 1, canonicalVersion: 1, currentVersion: 1, contentHash: `hash-${id}`,
    origin: 'manual_note', sourceKind: 'manual', curationKey: null, createdByRequestId: `request-${id}`, ...fields,
  } };
}
const ids = (result: ReturnType<ReturnType<typeof createKnowledgeIndex>['search']>) => result.hits.map(hit => hit.id);

describe('Knowledge lexical query policy', () => {
  it('filters prior Archive revisions before top-k, with explicit previous-version opt-in', () => {
    const archive = (id: string, latest: boolean) => ({ ...doc(id, 'retained-marker', {}, ['chatgpt']), archive: {
      conversationId: 'conversation', captureId: 'capture', messageId: id, revisionId: id, title: 'Conversation', latest,
      status: 'interrupted' as const, completion: 'unknown' as const, role: 'assistant' as const, scope: 'message' as const,
    } });
    const index = createKnowledgeIndex([...Array.from({ length: 75 }, (_, i) => archive(`old-${i}`, false)), archive('current', true)]);
    expect(ids(index.search('retained-marker'))).toEqual(['current']);
    expect(index.search('retained-marker', { filters: { includePreviousVersions: true } }).total).toBe(76);
    expect(index.search('retained-marker', { filters: { provider: 'manual', includePreviousVersions: true } }).total).toBe(0);
    expect(index.search('retained-marker', { filters: { dateFrom: '2026-10-02' } }).total).toBe(0);
  });
  it('keeps complete identifiers distinct from component aliases and labels prefixes', () => {
    const index = createKnowledgeIndex([
      doc('exact', 'HT-928 client.retry.count /etc/pine/config.toml --dry-run 1.2.3 C:\\pine\\config.toml'),
      doc('components', 'HT 928 client retry count etc pine config toml dry run 1 2 3'),
      doc('longer', 'HT-9280 client.retry.counted /etc/pine/config.tomlx --dry-running 1.2.30 C:\\pine\\config.tomlx'),
    ]);
    for (const query of ['HT-928', 'client.retry.count', '/etc/pine/config.toml', '--dry-run', '1.2.3', 'C:\\pine\\config.toml']) {
      expect(tokenize(query)).toContain(query.toLowerCase());
      const result = index.search(query);
      expect(result.hits[0]).toMatchObject({ id: 'exact', matchClass: 'exact' });
      expect(result.hits[1]).toMatchObject({ id: 'longer', matchClass: 'prefix' });
      expect(ids(result)).not.toContain('components');
    }
    expect(ids(index.search('retry'))).toContain('exact');
  });

  it('uses AND across input terms and explicit OR across alternatives', () => {
    const index = createKnowledgeIndex([doc('both', 'blue green'), doc('blue', 'blue'), doc('green', 'green')]);
    expect(ids(index.search('blue green'))).toEqual(['both']);
    expect(new Set(ids(index.search('blue green', { broaden: true })))).toEqual(new Set(['both', 'blue', 'green']));
    expect(index.search('blue absent').total).toBe(0);
  });

  it('verifies canonical phrase punctuation and spacing, without fuzzy or prefix changes', () => {
    const index = createKnowledgeIndex([
      doc('contiguous', 'alpha beta'), doc('gap', 'alpha useful beta'), doc('newline', 'alpha\nbeta'),
      doc('punctuation', 'alpha, beta'), doc('inside', 'preamble alphabeta ending'),
    ]);
    expect(ids(index.search('"alpha beta"', { fuzzy: true }))).toEqual(['contiguous']);
    expect(ids(index.search('"alpha, beta"'))).toEqual(['punctuation']);
    expect(ids(index.search('"alphabe"'))).toEqual(['inside']);
    expect(index.search('"alpha bet"').total).toBe(1); // Exact contiguous substring, not token expansion.
    expect(index.search('"alpha bet"').hits[0]?.reason).toBe('Exact phrase in body');
    expect(index.search('"alpha betz"', { fuzzy: true }).total).toBe(0);
  });

  it('allows prefix only on the final unquoted token of at least three code points', () => {
    const index = createKnowledgeIndex([doc('one', 'retry client'), doc('two', 'retry clients')]);
    expect(index.search('ret client').total).toBe(0);
    expect(index.search('retry cl').total).toBe(0);
    expect(index.search('retry cli').total).toBe(2);
    expect(index.search('retry "cli"').hits.every(hit => hit.matchClass === 'exact')).toBe(true);
  });

  it('keeps exact above prefix above explicitly requested fuzzy and never claims autocorrection', () => {
    const index = createKnowledgeIndex([
      doc('exact', 'copper'), doc('prefix', 'copperhead'), doc('fuzzy', 'coppar'),
    ]);
    expect(ids(index.search('copper'))).toEqual(['exact', 'prefix']);
    const result = index.search('copper', { fuzzy: true });
    expect(ids(result)).toEqual(['exact', 'prefix', 'fuzzy']);
    expect(result.hits.map(hit => hit.matchClass)).toEqual(['exact', 'prefix', 'fuzzy']);
    expect(result.hits[2]?.reason).toBe('Similar spelling in body');
    const prefix = result.hits[1]!.snippet;
    expect(Array.from(prefix.text).slice(prefix.matchStart! - prefix.start, prefix.matchEnd! - prefix.start).join('')).toBe('copper');
    const similar = result.hits[2]!.snippet;
    expect(Array.from(similar.text).slice(similar.matchStart! - similar.start, similar.matchEnd! - similar.start).join('')).toBe('coppar');
    expect(index.search('coper').total).toBe(0);
    expect(ids(index.search('coper', { fuzzy: true }))).toContain('exact');
  });

  it('searches Chinese word/bigram alternatives while checking the full intended text', () => {
    const index = createKnowledgeIndex([
      doc('learn', '通过费曼学习方法解释概念。'), doc('unrelated', '学习英语的方法。'), doc('english', 'Feynman technique'),
    ]);
    expect(ids(index.search('费曼'))).toEqual(['learn']);
    expect(ids(index.search('学习方法'))).toEqual(['learn']);
    expect(ids(index.search('"学习方法"'))).toEqual(['learn']);
    expect(ids(index.search('费'))).toEqual(['learn']);
    expect(ids(index.search('教别人来理解'))).toEqual([]);
    expect(ids(index.search('Feynman'))).toEqual(['english']);
  });

  it('weights title 4, tags 3, body/personal explanation 1 and uses review only to break ties', () => {
    const index = createKnowledgeIndex([
      doc('title', 'unrelated', { title: 'voltage' }), doc('tags', 'unrelated', { tags: ['voltage'] }),
      doc('body', 'voltage'), doc('explanation', 'unrelated', { personalExplanation: 'voltage' }),
    ]);
    expect(ids(index.search('voltage')).slice(0, 2)).toEqual(['title', 'tags']);
    const ties = createKnowledgeIndex([
      doc('old', 'voltage', { reviewedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-15T00:00:00.000Z' }),
      doc('recent', 'voltage', { reviewedAt: '2026-10-12T00:00:00.000Z' }), doc('a', 'voltage'), doc('b', 'voltage'),
    ]);
    expect(ids(ties.search('voltage'))).toEqual(['recent', 'old', 'a', 'b']);
    expect(ids(createKnowledgeIndex([doc('version', 'none', { applicableVersion: 'v2.4.7' })]).search('v2.4.7'))).toEqual(['version']);
  });

  it('maps snippets to exact canonical code points after emoji, NFC composition and case expansion', () => {
    const original = `${'🧠'.repeat(80)}\n\tconst Cafe\u0301 = "İtem";\n    return "中文";\n${'x'.repeat(200)}`;
    const note = doc('unicode', original);
    const before = JSON.stringify(note);
    const index = createKnowledgeIndex([note]);
    for (const [query, canonicalMatch] of [['café', 'Cafe\u0301'], ['İtem', 'İtem'], ['中文', '中文']] as const) {
      const hit = index.search(query).hits[0]!;
      expect(hit).toBeDefined();
      expect(hit.snippet.start).toBeGreaterThan(0);
      expect(Array.from(original).slice(hit.snippet.start, hit.snippet.end).join('')).toBe(hit.snippet.text);
      expect(hit.snippet.text).toContain('Cafe\u0301');
      expect(hit.snippet.matchStart).toBeGreaterThanOrEqual(hit.snippet.start);
      expect(hit.snippet.matchEnd).toBeLessThanOrEqual(hit.snippet.end);
      expect(Array.from(original).slice(hit.snippet.matchStart, hit.snippet.matchEnd).join('')).toBe(canonicalMatch);
      expect(Array.from(hit.snippet.text).slice(hit.snippet.matchStart! - hit.snippet.start, hit.snippet.matchEnd! - hit.snippet.start).join('')).toBe(canonicalMatch);
    }
    expect(JSON.stringify(note)).toBe(before);
  });

  it('distinguishes recent items, punctuation/no-match, and malformed quotes', () => {
    const index = createKnowledgeIndex([doc('old', 'one'), doc('new', 'two', { createdAt: '2026-10-16T00:00:00.000Z' })]);
    expect(ids(index.search('  '))).toEqual(['new', 'old']);
    expect(index.search('  ').hits[0]?.matchClass).toBe('recent');
    expect(index.search('  ').hits[0]?.snippet).not.toHaveProperty('matchStart');
    expect(index.search('  ').hits[0]?.snippet).not.toHaveProperty('matchEnd');
    expect(index.search('???')).toEqual({ hits: [], total: 0 });
    expect(index.search('impossible')).toEqual({ hits: [], total: 0 });
    expect(parseQuery('"unfinished').error).toMatch(/quotation/);
    expect(index.search('"unfinished').error).toBeDefined();
    expect(index.search('x'.repeat(1001)).error).toBeDefined();
  });
});

describe('eligibility before top-k', () => {
  const decoys = Array.from({ length: 150 }, (_, i) => doc(`decoy-${i}`, 'needle red separate fox', { title: 'needle red fox', tags: ['noise'] }, ['chatgpt']));
  const eligible = doc('eligible', 'needle red fox', {
    type: 'procedure', tags: ['Target'], reviewState: 'endorsed', createdAt: '2026-10-12T00:00:00.000Z', reviewedAt: '2026-10-14T00:00:00.000Z',
  }, ['chatgpt', 'gemini']);
  it('finds a low-ranked eligible record beyond 150 higher-ranked candidates using every metadata filter', () => {
    const index = createKnowledgeIndex([...decoys, eligible]);
    expect(ids(index.search('needle'))).not.toContain('eligible');
    const result = index.search('needle', { filters: {
      provider: 'gemini', type: 'procedure', tag: 'target', reviewState: 'endorsed', dateFrom: '2026-10-12', dateTo: '2026-10-12',
    } });
    expect(ids(result)).toEqual(['eligible']);
    expect(result.total).toBe(1);
    expect(ids(index.search('needle', { filters: { dateField: 'reviewed', dateFrom: '2026-10-14', dateTo: '2026-10-14' } }))).toEqual(['eligible']);
    expect(index.search('needle', { filters: { dateField: 'reviewed', dateTo: '2026-10-13' } }).total).toBe(0);
  });
  it('verifies phrases across all candidates before truncation, including many misleading high scores', () => {
    const index = createKnowledgeIndex([
      ...decoys.map(value => ({ ...value, note: { ...value.note, title: 'red separate fox', plainText: 'red distinct fox' } })), eligible,
    ]);
    expect(ids(index.search('"red fox"'))).toEqual(['eligible']);
  });
  it('keeps saved/endorsed/needs-review visible and requires Include outdated for superseded', () => {
    const index = createKnowledgeIndex(['saved', 'endorsed', 'needs_review', 'superseded'].map(state => doc(state, 'needle', { reviewState: state as KnowledgeItem['reviewState'] })));
    expect(index.search('needle').total).toBe(3);
    expect(index.search('needle', { filters: { reviewState: 'superseded' } }).total).toBe(0);
    expect(ids(index.search('needle', { filters: { includeOutdated: true, reviewState: 'superseded' } }))).toEqual(['superseded']);
    expect(index.search('needle', { filters: { provider: 'manual' } }).total).toBe(3);
    expect(index.search('needle', { filters: { provider: 'chatgpt' } }).total).toBe(0);
  });
  it('returns at most 50 while reporting the complete eligible total', () => {
    const result = createKnowledgeIndex(decoys).search('needle');
    expect(result.total).toBe(150);
    expect(result.hits).toHaveLength(50);
  });
});

describe('dedicated search worker fencing and rebuilding', () => {
  const marker: SearchMarker = { generation: 'generation-a', dataSeq: 1, policyVersion: SEARCH_POLICY_VERSION };
  it('starts empty, gates generation/sequence/config and ignores old query/build IDs', () => {
    const replies: SearchWorkerReply[] = [];
    const receive = createSearchWorkerHandler(reply => replies.push(reply));
    receive({ type: 'search', queryId: 1, marker, query: 'needle', options: {} });
    expect(replies.at(-1)).toMatchObject({ type: 'results', result: { total: 0, error: expect.any(String) } });
    receive({ type: 'build', buildId: 1, marker, documents: [doc('current', 'needle')] });
    expect(replies.at(-1)).toMatchObject({ type: 'ready', buildId: 1, marker });
    receive({ type: 'search', queryId: 3, marker, query: 'needle', options: {} });
    expect(replies.at(-1)).toMatchObject({ type: 'results', queryId: 3, result: { hits: [{ id: 'current' }] } });
    const count = replies.length;
    receive({ type: 'search', queryId: 2, marker, query: 'old', options: {} });
    receive({ type: 'build', buildId: 0, marker, documents: [doc('old', 'needle')] });
    expect(replies).toHaveLength(count);
    receive({ type: 'search', queryId: 4, marker: { ...marker, dataSeq: 2 }, query: 'needle', options: {} });
    expect(replies.at(-1)).toMatchObject({ type: 'results', result: { hits: [], error: expect.any(String) } });
    receive({ type: 'search', queryId: 5, marker: { ...marker, generation: 'restored' }, query: 'needle', options: {} });
    expect(replies.at(-1)).toMatchObject({ type: 'results', result: { hits: [], error: expect.any(String) } });
    receive({ type: 'build', buildId: 2, marker: { ...marker, policyVersion: 'obsolete' }, documents: [] });
    expect(replies.at(-1)).toMatchObject({ type: 'error' });
  });
  it('drops failed/corrupt builds and accepts a fresh canonical rebuild without retaining removed content', () => {
    const replies: SearchWorkerReply[] = [];
    const receive = createSearchWorkerHandler(reply => replies.push(reply));
    receive({ type: 'build', buildId: 1, marker, documents: [doc('old', 'needle')] });
    receive({ type: 'build', buildId: 2, marker, documents: [doc('duplicate', 'needle'), doc('duplicate', 'needle')] });
    expect(replies.at(-1)).toMatchObject({ type: 'error' });
    receive({ type: 'search', queryId: 1, marker, query: 'needle', options: {} });
    expect(replies.at(-1)).toMatchObject({ type: 'results', result: { hits: [], error: expect.any(String) } });
    const newer = { ...marker, dataSeq: 2 };
    receive({ type: 'build', buildId: 3, marker: newer, documents: [doc('updated', 'new value')] });
    receive({ type: 'search', queryId: 2, marker: newer, query: 'needle', options: {} });
    expect(replies.at(-1)).toMatchObject({ type: 'results', result: { hits: [], total: 0 } });
    receive({ type: 'search', queryId: 3, marker: newer, query: 'value', options: {} });
    expect(replies.at(-1)).toMatchObject({ type: 'results', result: { hits: [{ id: 'updated' }] } });
  });
});
