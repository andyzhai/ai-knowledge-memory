import { exactKeys, isId, isIso, isVersion, type LibraryReply } from './knowledge';
import { canonicalRoute, MAX_FRAGMENTS, MAX_SELECTION_BYTES } from './protocol';

export type SelectionFragment = { role: 'user' | 'assistant' | 'unknown'; sourceMessageId: string | null; exactText: string; startCodePoint: number; endCodePoint: number; kind: 'text' | 'code' };
export type SelectionSnapshot = {
  sourceUrl: string; selectedText: string; fragments: SelectionFragment[]; extractorVersion: string;
  temporaryStatus: 'unknown' | 'temporary'; historyCoverage: 'unknown'; branchCoverage: 'observed_only'; completion: 'unknown'; warnings: string[];
};
export type SourceBinding = { tabId: number; documentId: string; route: string; nonce: string };
export type CurationOwner = Omit<SourceBinding, 'route'> & { routeDigest: string };
export type CurateSelection = {
  protocolVersion: 1; type: 'CurateSelection'; requestId: string; issuedAt: string; generation: string;
  providerEpoch: string; nonce: string; snapshot: SelectionSnapshot;
};
export type SelectionAction = {
  protocolVersion: 1; type: 'UndoSelection' | 'EndorseSelection'; requestId: string; issuedAt: string;
  generation: string; savedRequestId: string; expectedRecordVersion: number;
};
export type CurationCommand = CurateSelection | SelectionAction
  | { protocolVersion: 1; type: 'BeginSelection'; route: string; nonce: string }
  | { protocolVersion: 1; type: 'OpenSelection'; generation: string; savedRequestId: string };
export type CurationReply = LibraryReply | { ok: true; generation: string; providerEpoch: string } | { ok: true };
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.isWellFormed() && v.length <= max;
export function validSnapshot(v: unknown): v is SelectionSnapshot {
  if (!exactKeys(v, ['sourceUrl', 'selectedText', 'fragments', 'extractorVersion', 'temporaryStatus', 'historyCoverage', 'branchCoverage', 'completion', 'warnings'])) return false;
  if (!text(v.sourceUrl, 2048) || canonicalRoute(v.sourceUrl) !== v.sourceUrl || !text(v.selectedText, MAX_SELECTION_BYTES) || !v.selectedText.trim() ||
      !['a2-dom-text-1', 'a2-dom-text-2'].includes(v.extractorVersion as string) || !['unknown', 'temporary'].includes(v.temporaryStatus as string) ||
      v.historyCoverage !== 'unknown' || v.branchCoverage !== 'observed_only' || v.completion !== 'unknown' ||
      !Array.isArray(v.warnings) || v.warnings.length > 16 || !v.warnings.every(w => text(w, 100) && /^[a-z_]+$/.test(w)) ||
      !Array.isArray(v.fragments) || !v.fragments.length || v.fragments.length > MAX_FRAGMENTS) return false;
  if (!v.fragments.every(f => exactKeys(f, ['role', 'sourceMessageId', 'exactText', 'startCodePoint', 'endCodePoint', 'kind']) &&
    ['user', 'assistant', 'unknown'].includes(f.role as string) && ['text', 'code'].includes(f.kind as string) &&
    (f.sourceMessageId === null || (text(f.sourceMessageId, 256) && /^[\w-]+$/.test(f.sourceMessageId))) && text(f.exactText, MAX_SELECTION_BYTES) && f.exactText.length > 0 &&
    Number.isSafeInteger(f.startCodePoint) && Number.isSafeInteger(f.endCodePoint) && (f.startCodePoint as number) >= 0 &&
    (f.endCodePoint as number) <= 1024 * 1024 && (f.endCodePoint as number) - (f.startCodePoint as number) === Array.from(f.exactText).length)) return false;
  return new TextEncoder().encode(JSON.stringify(v)).length <= MAX_SELECTION_BYTES;
}
export function parseCurationCommand(value: unknown): CurationCommand | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.protocolVersion !== 1) return null;
  if (v.type === 'BeginSelection' && exactKeys(v, ['protocolVersion', 'type', 'route', 'nonce']) && text(v.route, 2048) && canonicalRoute(v.route) === v.route && isId(v.nonce)) return v as CurationCommand;
  if (v.type === 'OpenSelection' && exactKeys(v, ['protocolVersion', 'type', 'generation', 'savedRequestId']) && isId(v.generation) && isId(v.savedRequestId)) return v as CurationCommand;
  if (!isId(v.generation) || !isId(v.requestId) || !isIso(v.issuedAt)) return null;
  if (v.type === 'CurateSelection' && exactKeys(v, ['protocolVersion', 'type', 'requestId', 'issuedAt', 'generation', 'providerEpoch', 'nonce', 'snapshot']) && isId(v.providerEpoch) && isId(v.nonce) && validSnapshot(v.snapshot)) return v as CurationCommand;
  if (['UndoSelection', 'EndorseSelection'].includes(v.type as string) && exactKeys(v, ['protocolVersion', 'type', 'requestId', 'issuedAt', 'generation', 'savedRequestId', 'expectedRecordVersion']) && isId(v.savedRequestId) && isVersion(v.expectedRecordVersion)) return v as CurationCommand;
  return null;
}
