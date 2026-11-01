import { exactKeys, isId, type LibraryReply } from './knowledge';
import type { SearchDocument } from './search';

export type CanonicalMarker = { generation: string; dataSeq: number };
export type SearchReadCommand =
  | { protocolVersion: 1; type: 'GetSearchState' | 'GetArchiveSearchState' }
  | { protocolVersion: 1; type: 'ReadSearchPage' | 'ReadArchiveSearchPage'; marker: CanonicalMarker; afterId: string | null }
  | { protocolVersion: 1; type: 'HydrateSearchResults' | 'HydrateArchiveSearchResults'; marker: CanonicalMarker; ids: string[] };
export type SearchReadReply =
  | { ok: true; marker: CanonicalMarker; total: number }
  | { ok: true; marker: CanonicalMarker; documents: SearchDocument[]; nextId: string | null }
  | Extract<LibraryReply, { ok: false }>;

export function parseSearchReadCommand(value: unknown): SearchReadCommand | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.protocolVersion !== 1) return null;
  if (['GetSearchState', 'GetArchiveSearchState'].includes(v.type as string) && exactKeys(v, ['protocolVersion', 'type'])) return v as SearchReadCommand;
  if (!exactKeys(v.marker, ['generation', 'dataSeq']) || !isId(v.marker.generation) || !Number.isSafeInteger(v.marker.dataSeq) || (v.marker.dataSeq as number) < 0) return null;
  if (['ReadSearchPage', 'ReadArchiveSearchPage'].includes(v.type as string) && exactKeys(v, ['protocolVersion', 'type', 'marker', 'afterId']) && (v.afterId === null || isId(v.afterId))) return v as SearchReadCommand;
  if (['HydrateSearchResults', 'HydrateArchiveSearchResults'].includes(v.type as string) && exactKeys(v, ['protocolVersion', 'type', 'marker', 'ids']) && Array.isArray(v.ids) && v.ids.length <= 8 && v.ids.every(isId) && new Set(v.ids).size === v.ids.length) return v as SearchReadCommand;
  return null;
}

export const sameCanonicalMarker = (a: CanonicalMarker | undefined, b: CanonicalMarker | undefined) => !!a && !!b && a.generation === b.generation && a.dataSeq === b.dataSeq;
