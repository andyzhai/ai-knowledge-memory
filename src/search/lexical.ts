import MiniSearch from 'minisearch';
import type { KnowledgeItem } from '../shared/knowledge';
import type { MatchClass, SearchDocument, SearchField, SearchFilters, SearchHit, SearchOptions, SearchResult } from '../shared/search';

const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const fields: SearchField[] = ['title', 'tags', 'plainText', 'personalExplanation', 'applicableVersion'];
const boosts = { title: 4, tags: 3, plainText: 1, personalExplanation: 1, applicableVersion: 1 };
const normalize = (value: string) => value.normalize('NFC').toLowerCase();
const hasText = (value: string) => /[\p{L}\p{N}]/u.test(value);
type Occurrence = { term: string; start: number; end: number };
type QueryTerm = { text: string; phrase: boolean; prefix: boolean };
type FieldView = { original: string; normalized: string; tokens: Occurrence[] };
type IndexedDocument = { document: SearchDocument; views: Record<SearchField, FieldView> };
type Match = { field: SearchField; start: number; end: number; kind: Exclude<MatchClass, 'recent' | 'semantic'>; phrase: boolean; identifier: boolean };
const classOrder = { exact: 0, prefix: 1, fuzzy: 2, recent: 3 };

// Whole technical spans and components share normalized UTF-16 offsets.
// Only final snippets are mapped to original canonical code-point offsets.
function occurrences(normalized: string): Occurrence[] {
  const found: Occurrence[] = [];
  const seen = new Set<string>();
  const add = (term: string, start: number) => {
    if (!hasText(term)) return;
    const key = `${start}:${term}`;
    if (!seen.has(key)) { found.push({ term, start, end: start + term.length }); seen.add(key); }
  };
  for (const match of normalized.matchAll(/[\p{L}\p{M}\p{N}_./\\:\-]+/gu)) {
    const term = match[0].replace(/[./\\:\-]+$/u, '');
    add(term, match.index);
    for (const component of term.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) add(component[0], match.index + component.index);
  }
  for (const part of wordSegmenter.segment(normalized)) if (part.isWordLike) add(part.segment, part.index);
  for (const group of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const chars = Array.from(group[0]);
    let offset = group.index;
    for (let i = 0; i < chars.length; i++) {
      add(chars[i]!, offset);
      if (i + 1 < chars.length) add(chars[i]! + chars[i + 1]!, offset);
      offset += chars[i]!.length;
    }
  }
  return found;
}

export function tokenize(text: string): string[] { return occurrences(normalize(text)).map(value => value.term); }

export function parseQuery(query: string): { terms: QueryTerm[]; error?: string } {
  if (query.length > 1000) return { terms: [], error: 'Search queries can contain at most 1,000 characters.' };
  const terms: QueryTerm[] = [];
  let cursor = 0;
  while (cursor < query.length) {
    if (/\s/u.test(query[cursor]!)) { cursor++; continue; }
    if (query[cursor] === '"') {
      const end = query.indexOf('"', cursor + 1);
      if (end < 0) return { terms: [], error: 'Close the quotation mark to search for an exact phrase.' };
      const text = normalize(query.slice(cursor + 1, end));
      if (hasText(text)) terms.push({ text, phrase: true, prefix: false });
      cursor = end + 1;
    } else {
      const next = /^[^\s"]+/u.exec(query.slice(cursor))![0];
      for (const part of normalize(next).matchAll(/[\p{L}\p{M}\p{N}_./\\:\-]+/gu)) {
        const text = part[0].replace(/[./\\:\-]+$/u, '');
        if (hasText(text)) terms.push({ text, phrase: false, prefix: false });
      }
      cursor += next.length;
    }
  }
  const last = terms.at(-1);
  if (last && !last.phrase && Array.from(last.text).length >= 3) last.prefix = true;
  return { terms };
}

export function matchesFilters(document: SearchDocument, filter: SearchFilters = {}): boolean {
  const { note, providers } = document;
  if (document.archive && !document.archive.latest && !filter.includePreviousVersions) return false;
  if (note.reviewState === 'superseded' && !filter.includeOutdated) return false;
  if (note.excluded && !filter.includeExcluded) return false;
  if (filter.provider && !providers.includes(filter.provider)) return false;
  if (filter.type && note.type !== filter.type) return false;
  if (filter.tag && !note.tags.some(tag => normalize(tag) === normalize(filter.tag!))) return false;
  if (filter.reviewState && note.reviewState !== filter.reviewState) return false;
  if (filter.dateFrom || filter.dateTo) {
    const date = (filter.dateField === 'reviewed' ? note.reviewedAt : note.createdAt)?.slice(0, 10);
    if (!date || (filter.dateFrom && date < filter.dateFrom) || (filter.dateTo && date > filter.dateTo)) return false;
  }
  return true;
}

function fieldText(note: KnowledgeItem, field: SearchField): string { return field === 'tags' ? note.tags.join('\n') : note[field]; }
const technical = (term: string) => /[_./\\:\-]/u.test(term);
const fuzzyDistance = (term: string) => Array.from(term).length >= 8 ? 2 : 1;

function withinDistance(left: string, right: string, max: number): boolean {
  const a = Array.from(left), b = Array.from(right);
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current.push(Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    if (Math.min(...current) > max) return false;
    previous = current;
  }
  return previous[b.length]! <= max;
}

function verify(indexed: IndexedDocument, term: QueryTerm, fuzzy: boolean): Match | undefined {
  const matches: Match[] = [];
  for (const field of fields) {
    const view = indexed.views[field];
    const base = { field, phrase: term.phrase, identifier: technical(term.text) };
    // CJK aliases are candidate alternatives. Verify actual contiguous Chinese
    // text rather than accepting a match of one unrelated generated bigram.
    if (term.phrase || /\p{Script=Han}/u.test(term.text)) {
      const position = view.normalized.indexOf(term.text);
      if (position >= 0) matches.push({ ...base, start: position, end: position + term.text.length, kind: 'exact' });
      if (term.phrase) continue;
    }
    for (const occurrence of view.tokens) {
      const kind = occurrence.term === term.text ? 'exact'
        : term.prefix && occurrence.term.startsWith(term.text) ? 'prefix'
          : fuzzy && Array.from(term.text).length >= 3 && withinDistance(term.text, occurrence.term, fuzzyDistance(term.text)) ? 'fuzzy' : null;
      if (kind) matches.push({ ...base, start: occurrence.start, end: kind === 'prefix' ? occurrence.start + term.text.length : occurrence.end, kind });
    }
  }
  return matches.sort((a, b) => classOrder[a.kind] - classOrder[b.kind] || boosts[b.field] - boosts[a.field] || a.start - b.start)[0];
}

function snippet(view: FieldView, field: SearchField, match?: Match): SearchHit['snippet'] {
  const chars = Array.from(view.original);
  let matchStart = 0, matchEnd = 0;
  if (match) {
    let canonical = 0, normalized = 0;
    for (const part of graphemeSegmenter.segment(view.original)) {
      const canonicalLength = Array.from(part.segment).length;
      const normalizedLength = normalize(part.segment).length;
      if (normalized <= match.start && match.start < normalized + normalizedLength) matchStart = canonical;
      if (normalized < match.end && match.end <= normalized + normalizedLength) { matchEnd = canonical + canonicalLength; break; }
      canonical += canonicalLength; normalized += normalizedLength;
    }
  }
  const start = Math.max(0, matchStart - 48);
  const end = Math.min(chars.length, Math.max(start + 180, matchEnd));
  return { text: chars.slice(start, end).join(''), start, end, field, ...(match ? { matchStart, matchEnd } : {}) };
}

function matchReason(match: Match): string {
  const label = match.field === 'plainText' ? 'body' : match.field === 'personalExplanation' ? 'personal explanation' : match.field === 'applicableVersion' ? 'applicable version' : match.field;
  return `${match.kind === 'fuzzy' ? 'Similar spelling' : match.kind === 'prefix' ? 'Prefix' : match.phrase ? 'Exact phrase' : match.identifier ? 'Exact identifier' : 'Exact term'} in ${label}`;
}

export function createKnowledgeIndex(documents: SearchDocument[]) {
  const indexed = new Map<string, IndexedDocument>();
  const engine = new MiniSearch({ fields, tokenize, processTerm: term => term, searchOptions: { boost: boosts } });
  for (const document of documents) {
    if (indexed.has(document.note.id)) throw new Error('Duplicate search document.');
    const views = {} as Record<SearchField, FieldView>;
    const flat: Record<string, string> = { id: document.note.id };
    for (const field of fields) {
      const original = fieldText(document.note, field), normalized = normalize(original);
      views[field] = { original, normalized, tokens: occurrences(normalized) };
      flat[field] = original;
    }
    indexed.set(document.note.id, { document, views });
    engine.add(flat);
  }
  return {
    search(query: string, options: SearchOptions = {}): SearchResult {
      const parsed = parseQuery(query);
      if (parsed.error) return { hits: [], total: 0, error: parsed.error };
      const { terms } = parsed;
      if (!query.trim()) {
        const eligible = [...indexed.values()].filter(value => matchesFilters(value.document, options.filters))
          .sort((a, b) => b.document.note.createdAt.localeCompare(a.document.note.createdAt) || a.document.note.id.localeCompare(b.document.note.id, 'en'));
        return { total: eligible.length, hits: eligible.slice(0, 50).map(value => ({
          id: value.document.note.id, recordVersion: value.document.note.recordVersion, contentHash: value.document.note.contentHash,
          matchClass: 'recent', reason: 'Recently saved', score: 0, snippet: snippet(value.views.plainText, 'plainText'),
        })) };
      }
      if (!terms.length) return { hits: [], total: 0 };
      const candidates = terms.map(term => {
        const aliases = term.phrase || /\p{Script=Han}/u.test(term.text) ? [...new Set(tokenize(term.text))] : [term.text];
        const scores = new Map(engine.search(term.text, {
          tokenize: () => aliases, combineWith: 'OR', prefix: term.prefix,
          fuzzy: options.fuzzy && !term.phrase && Array.from(term.text).length >= 3 ? fuzzyDistance(term.text) : false,
          boost: boosts,
        }).map(hit => [String(hit.id), hit.score]));
        // Quoted text is contiguous canonical text, including text inside a
        // larger token. MiniSearch cannot retrieve every substring, so phrase
        // verification considers the complete corpus (without a top-k cutoff).
        if (term.phrase) for (const id of indexed.keys()) if (!scores.has(id)) scores.set(id, 0);
        return scores;
      });
      const candidateIds = options.broaden ? new Set(candidates.flatMap(list => [...list.keys()])) : new Set(candidates[0]?.keys());
      if (!options.broaden) for (const list of candidates.slice(1)) for (const id of candidateIds) if (!list.has(id)) candidateIds.delete(id);
      const verified: Array<{ indexed: IndexedDocument; match: Match; kind: Match['kind']; score: number }> = [];
      // No candidate cutoff: visibility, filters and canonical phrase/token
      // verification are complete before final top-50 selection.
      for (const id of candidateIds) {
        const value = indexed.get(id)!;
        if (!matchesFilters(value.document, options.filters)) continue;
        const matches = terms.map(term => verify(value, term, !!options.fuzzy));
        if (options.broaden ? !matches.some(Boolean) : matches.some(match => !match)) continue;
        const present = matches.filter((match): match is Match => !!match);
        present.sort((a, b) => classOrder[a.kind] - classOrder[b.kind] || Number(b.phrase || b.identifier) - Number(a.phrase || a.identifier) || boosts[b.field] - boosts[a.field]);
        const kind = options.broaden ? present[0]!.kind : present.at(-1)!.kind;
        const match = present.find(item => item.kind === kind)!;
        const score = candidates.reduce((sum, list, i) => sum + (matches[i] ? list.get(id) ?? 0 : 0), 0);
        verified.push({ indexed: value, match, kind, score });
      }
      verified.sort((a, b) => classOrder[a.kind] - classOrder[b.kind] || b.score - a.score
        || (b.indexed.document.note.reviewedAt ?? '').localeCompare(a.indexed.document.note.reviewedAt ?? '')
        || a.indexed.document.note.id.localeCompare(b.indexed.document.note.id, 'en'));
      return { total: verified.length, hits: verified.slice(0, 50).map(value => ({
        id: value.indexed.document.note.id, recordVersion: value.indexed.document.note.recordVersion, contentHash: value.indexed.document.note.contentHash,
        matchClass: value.kind, reason: matchReason(value.match), score: value.score,
        snippet: snippet(value.indexed.views[value.match.field], value.match.field, value.match),
      })) };
    },
  };
}

// A0's isolated fixture API remains available for its original evidence;
// production workers never populate this synthetic corpus.
export type ProbeNote = { id: string; title: string; body: string };
export const PROBE_NOTES: ProbeNote[] = [
  { id: 'retry', title: 'Retry policy for HT-928', body: 'For HT-928, set client.retry.count to 3 and run pine --dry-run. The config is /etc/pine/config.toml.' },
  { id: 'learning', title: '费曼学习法', body: '通过向别人解释概念，检查自己的理解。学习方法：先解释，再发现知识缺口。' },
  { id: 'unicode', title: 'Unicode notes', body: 'Keep emoji 🧠 and Chinese 中文 intact. Source text and search normalization are separate.' },
];
export function createProbeIndex(notes: ProbeNote[] = PROBE_NOTES) {
  const documents = notes.map(note => ({ providers: ['manual'], note: {
    id: note.id, title: note.title, plainText: note.body, tags: [], personalExplanation: '', applicableVersion: '',
    reviewState: 'saved', createdAt: '', reviewedAt: null, recordVersion: 1, contentHash: '',
  } }));
  const index = createKnowledgeIndex(documents as unknown as SearchDocument[]);
  return { search: (query: string) => query.trim() ? index.search(query).hits.map(hit => notes.find(note => note.id === hit.id)!) : [] };
}
