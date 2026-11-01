import type { Provider } from './archive';
import type { KnowledgeItem, NoteType, ReviewState } from './knowledge';

// Bump whenever normalization, tokenization, phrase verification, or ranking changes.
export const SEARCH_POLICY_VERSION = 'knowledge-nfc-segmenter-bigram-v1';
export type SearchDocument = { note: KnowledgeItem; providers: Array<Provider | 'manual'>; archive?: {
  conversationId: string; captureId: string; messageId: string; revisionId: string; title: string; latest: boolean;
  status: 'completed' | 'interrupted'; completion: import('./archive').Completion; role: import('./archive').Role; scope: import('./archive').Scope;
} };
export type SearchMarker = { generation: string; dataSeq: number; policyVersion: string };
export type SearchFilters = {
  provider?: Provider | 'manual'; type?: NoteType; tag?: string; reviewState?: ReviewState;
  dateFrom?: string; dateTo?: string; dateField?: 'saved' | 'reviewed'; includeOutdated?: boolean; includePreviousVersions?: boolean; includeExcluded?: boolean;
};
export type SearchOptions = { broaden?: boolean; fuzzy?: boolean; filters?: SearchFilters };
export type SearchField = 'title' | 'plainText' | 'personalExplanation' | 'tags' | 'applicableVersion';
export type MatchClass = 'exact' | 'prefix' | 'fuzzy' | 'recent' | 'semantic';
export type SearchHit = {
  id: string; recordVersion: number; contentHash: string; matchClass: MatchClass; reason: string; score: number;
  // Code-point offsets in the original canonical field; tags use tags.join('\n').
  // start/end bound context; matchStart/matchEnd identify actual matched text.
  snippet: { text: string; start: number; end: number; field: SearchField; matchStart?: number; matchEnd?: number };
};
export type SearchResult = { hits: SearchHit[]; total: number; error?: string };
export type SearchWorkerRequest =
  | { type: 'build'; buildId: number; marker: SearchMarker; documents: SearchDocument[] }
  | { type: 'search'; queryId: number; marker: SearchMarker; query: string; options: SearchOptions };
export type SearchWorkerReply =
  | { type: 'ready'; buildId: number; marker: SearchMarker }
  | { type: 'results'; queryId: number; marker: SearchMarker; result: SearchResult }
  | { type: 'error'; message: string };
export const sameSearchMarker = (a: SearchMarker | undefined, b: SearchMarker | undefined) =>
  !!a && !!b && a.generation === b.generation && a.dataSeq === b.dataSeq && a.policyVersion === b.policyVersion;
