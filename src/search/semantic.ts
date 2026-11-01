import type { EmbeddingProvider } from '../shared/semantic';
import type { SearchDocument, SearchField, SearchHit, SearchMarker, SearchOptions, SearchResult } from '../shared/search';
import { sameSearchMarker } from '../shared/search';
import { matchesFilters, parseQuery } from './lexical';

export type Chunk = { text: string; start: number; end: number; sources: { field: SearchField; start: number; end: number; offset: number }[] };
export type VectorRecord = { generation: string; noteId: string; recordVersion: number; contentHash: string; signature: string; chunk: Chunk; vector: number[] };
const fields: SearchField[] = ['title', 'plainText', 'personalExplanation', 'tags', 'applicableVersion'];

// Offsets are code points in a reversible representation; each source maps back
// to the original field. Prefer paragraph/line boundaries, then split oversized
// paragraphs/code lines. Token checks include special tokens, with no truncation.
export function chunkNote(document: SearchDocument, tokenCount: (text: string) => number): Chunk[] {
  const points: string[] = [], sources: Chunk['sources'] = [];
  for (const field of fields) {
    const text = field === 'tags' ? document.note.tags.join('\n') : document.note[field];
    if (!text) continue;
    if (points.length) points.push('\n', '\n');
    const chars = Array.from(text); sources.push({ field, start: 0, end: chars.length, offset: points.length });
    for (const char of chars) points.push(char);
  }
  const chunks: Chunk[] = [];
  for (let start = 0; start < points.length;) {
    let end = Math.min(points.length, start + 1024);
    while (tokenCount(points.slice(start, end).join('')) > 128) end = start + Math.floor((end - start) / 2);
    if (end === start) throw new Error('Cannot encode a source character.');
    if (end < points.length) {
      const boundary = points.slice(start, end).lastIndexOf('\n');
      if (boundary > (end - start) / 2) end = start + boundary + 1;
    }
    chunks.push({ text: points.slice(start, end).join(''), start, end, sources: sources.filter(source => source.offset < end && source.offset + source.end > start)
      .map(source => ({ ...source, start: Math.max(0, start - source.offset), end: Math.min(source.end, end - source.offset) })) });
    start = end;
  }
  return chunks;
}
export function normalizedVector(values: number[], dimensions: number): number[] {
  if (values.length !== dimensions || !values.every(Number.isFinite)) throw new Error('Invalid embedding dimensions/values.');
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('Invalid embedding norm.');
  return values.map(value => value / norm);
}
function semanticSnippet(document: SearchDocument, chunk: Chunk): SearchHit['snippet'] {
  const source = chunk.sources.find(source => source.field === 'plainText') ?? chunk.sources[0]!;
  const text = source.field === 'tags' ? document.note.tags.join('\n') : document.note[source.field];
  const end = Math.min(source.end, source.start + 180);
  return { text: Array.from(text).slice(source.start, end).join(''), field: source.field, start: source.start, end };
}
// Volatile store only: replacement, disable and worker termination drop vectors.
// Publication is fenced synchronously by epoch + marker + signature. Canonical
// hydration in the owner is the final fence before any candidate is displayed.
export class SemanticIndex {
  private epoch = 0;
  private marker?: SearchMarker;
  private documents = new Map<string, SearchDocument>();
  private records: VectorRecord[] = [];
  private signature = '';
  clear() { ++this.epoch; this.marker = undefined; this.documents.clear(); this.records = []; this.signature = ''; }
  async build(documents: SearchDocument[], marker: SearchMarker, provider: EmbeddingProvider): Promise<number | null> {
    this.clear(); const epoch = this.epoch;
    const records: VectorRecord[] = [];
    const current = new Map(documents.map(document => [document.note.id, document]));
    if (current.size !== documents.length) throw new Error('Duplicate note.');
    for (const document of documents) for (const chunk of chunkNote(document, text => provider.tokenCount(text))) {
      if (epoch !== this.epoch) return null;
      const vector = normalizedVector(await provider.embed(chunk.text), provider.dimensions);
      if (epoch !== this.epoch) return null;
      records.push({ generation: marker.generation, noteId: document.note.id, recordVersion: document.note.recordVersion,
        contentHash: document.note.contentHash, signature: provider.signature, chunk, vector });
    }
    if (epoch !== this.epoch) return null;
    this.marker = { ...marker }; this.signature = provider.signature; this.documents = current; this.records = records;
    return records.length;
  }
  async search(query: string, options: SearchOptions, marker: SearchMarker, provider: EmbeddingProvider): Promise<SearchResult> {
    const epoch = this.epoch;
    const valid = () => epoch === this.epoch && sameSearchMarker(marker, this.marker) && provider.signature === this.signature;
    if (!valid()) throw new Error('Stale semantic index.');
    const parsed = parseQuery(query);
    if (parsed.error || !parsed.terms.length) return { hits: [], total: 0, ...(parsed.error ? { error: parsed.error } : {}) };
    if (provider.tokenCount(query) > 128) return { hits: [], total: 0, error: 'Query is too long for this model. Lexical results remain complete.' };
    const queryVector = normalizedVector(await provider.embed(query), provider.dimensions);
    if (!valid()) throw new Error('Stale semantic result.');
    const notes = new Map<string, SearchHit>();
    for (const record of this.records) {
      const document = this.documents.get(record.noteId)!;
      if (!matchesFilters(document, options.filters) || record.signature !== provider.signature || record.generation !== marker.generation
        || record.recordVersion !== document.note.recordVersion || record.contentHash !== document.note.contentHash) continue;
      // Quoted constraints stay literal even in the optional meaning route.
      if (parsed.terms.some(term => term.phrase && !fields.some(field => (field === 'tags' ? document.note.tags.join('\n') : document.note[field]).normalize('NFC').toLowerCase().includes(term.text)))) continue;
      const score = record.vector.reduce((sum, value, i) => sum + value * queryVector[i]!, 0);
      if (notes.has(record.noteId) && notes.get(record.noteId)!.score >= score) continue;
      notes.set(record.noteId, { id: record.noteId, recordVersion: record.recordVersion, contentHash: record.contentHash, score,
        matchClass: 'semantic', reason: 'Related by meaning · suggestion, not a verified match', snippet: semanticSnippet(document, record.chunk) });
    }
    const hits = [...notes.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en'));
    return { total: hits.length, hits: hits.slice(0, 50) };
  }
}
export function fuseResults(lexical: SearchResult, semantic: SearchResult, k = 60): SearchResult {
  if (lexical.error || !Number.isFinite(k) || k <= 0) return lexical;
  const hits = new Map<string, SearchHit>(), scores = new Map<string, number>();
  for (const list of [lexical.hits, semantic.hits]) {
    const seen = new Set<string>();
    for (const hit of list) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id); if (!hits.has(hit.id)) hits.set(hit.id, hit);
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + seen.size));
    }
  }
  const exact = lexical.hits.filter(hit => hit.matchClass === 'exact');
  const protectedIds = new Set(exact.map(hit => hit.id));
  const rest = [...hits.values()].filter(hit => !protectedIds.has(hit.id)).sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || a.id.localeCompare(b.id, 'en'));
  return { total: hits.size, hits: [...exact, ...rest].slice(0, 50) };
}
