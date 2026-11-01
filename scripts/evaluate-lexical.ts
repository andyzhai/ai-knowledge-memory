import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createKnowledgeIndex } from '../src/search/lexical.ts';
import type { SearchDocument } from '../src/shared/search';
import { SEARCH_POLICY_VERSION } from '../src/shared/search.ts';

const corpus = JSON.parse(await readFile('tests/fixtures/evaluation-corpus.json', 'utf8')) as {
  version: string; notes: { id: string; title: string; body: string; tags: string[] }[];
  queries: { id: string; query: string; split: string; expected: string[]; kind: string }[];
};
const documents: SearchDocument[] = corpus.notes.map(note => ({ providers: ['manual'], note: {
  id: note.id, title: note.title, bodyMarkdown: note.body, plainText: note.body, tags: note.tags,
  schemaVersion: 1, recordVersion: 1, currentVersion: 1, canonicalVersion: 1, contentHash: '', type: 'reference',
  createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z', personalExplanation: '', applicableVersion: '', reviewAfter: null,
  reviewState: 'saved', reviewedAt: null, supersededById: null, origin: 'manual_note', sourceKind: 'manual', curationKey: null, createdByRequestId: note.id,
} }));
const index = createKnowledgeIndex(documents);
const rows = corpus.queries.map(query => {
  const start = performance.now(); const result = index.search(query.query); const elapsedMs = performance.now() - start;
  const top5 = result.hits.slice(0, 5).map(hit => hit.id);
  return { ...query, top5, elapsedMs, correctInTop5: query.expected.length ? top5.some(id => query.expected.includes(id)) : result.total === 0,
    reciprocalRank: query.expected.length ? 1 / (top5.findIndex(id => query.expected.includes(id)) + 1 || Infinity) : null };
});
await mkdir('artifacts', { recursive: true });
const output = { corpusVersion: corpus.version, policyVersion: SEARCH_POLICY_VERSION, mode: 'lexical-only', rows,
  summary: Object.fromEntries(['development', 'holdout'].map(split => { const subset = rows.filter(row => row.split === split); return [split, { count: subset.length, correctInTop5: subset.filter(row => row.correctInTop5).length }]; })) };
await writeFile('artifacts/a3-lexical-evaluation.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.summary));
