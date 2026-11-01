import { exactKeys, isId, isIso, isVersion, type LibraryReply, type SaveResult } from './knowledge';
import type { Provider } from './archive';

type Intent = { protocolVersion: 1; requestId: string; issuedAt: string; generation: string };
type NoteIntent = Intent & { noteId: string; expectedRecordVersion: number };
export type ManageNote = NoteIntent & (
  { type: 'ReviewNote'; state: 'endorsed' | 'needs_review' | 'superseded'; supersededById: string | null }
  | { type: 'ExcludeNote'; excluded: boolean }
  | { type: 'DuplicateNote' }
  | { type: 'AddNoteSource'; source: { kind: 'existing'; sourceId: string } | { kind: 'archive'; captureId: string; revisionId: string; quote: string } }
);
export type DeleteTarget = { kind: 'note'; noteId: string }
  | { kind: 'conversation'; conversationId: string; mode: 'keep_knowledge' | 'with_knowledge' }
  | { kind: 'archive_filter'; provider: Provider | null; through: string }
  | { kind: 'all' };
export type DeleteCommand = { protocolVersion: 1; type: 'PreviewDeletion'; generation: string; target: DeleteTarget }
  | Intent & { type: 'DeleteLibraryData'; target: DeleteTarget; expectedDataSeq: number };
export type DeletionPreview = {
  generation: string; dataSeq: number; target: DeleteTarget;
  notes: { id: string; title: string; sources: number }[];
  conversations: { id: string; title: string }[];
  counts: { notes: number; histories: number; sourceCopies: number; captures: number; messages: number; revisions: number };
  retainedNotes: number; detachedSources: number; supersessionLinks: number;
};
export type ManagementReply = LibraryReply | { ok: true; preview: DeletionPreview } | { ok: true; result: SaveResult };
export function validDeleteTarget(v: unknown): v is DeleteTarget {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  if (t.kind === 'all') return exactKeys(t, ['kind']);
  if (t.kind === 'note') return exactKeys(t, ['kind', 'noteId']) && isId(t.noteId);
  if (t.kind === 'conversation') return exactKeys(t, ['kind', 'conversationId', 'mode']) && isId(t.conversationId) && ['keep_knowledge', 'with_knowledge'].includes(t.mode as string);
  return t.kind === 'archive_filter' && exactKeys(t, ['kind', 'provider', 'through']) && (t.provider === null || ['chatgpt', 'gemini', 'perplexity'].includes(t.provider as string)) &&
    typeof t.through === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.through) && Number.isFinite(Date.parse(t.through)) && new Date(t.through).toISOString().slice(0, 10) === t.through;
}
export function parseManagement(v: unknown): ManageNote | DeleteCommand | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (c.protocolVersion !== 1 || !isId(c.generation)) return null;
  if (c.type === 'PreviewDeletion') return exactKeys(c, ['protocolVersion', 'type', 'generation', 'target']) && validDeleteTarget(c.target) ? c as DeleteCommand : null;
  const intent = ['protocolVersion', 'type', 'requestId', 'issuedAt', 'generation'];
  if (!isId(c.requestId) || !isIso(c.issuedAt)) return null;
  if (c.type === 'DeleteLibraryData') return exactKeys(c, [...intent, 'target', 'expectedDataSeq']) && validDeleteTarget(c.target) && Number.isSafeInteger(c.expectedDataSeq) && (c.expectedDataSeq as number) >= 0 ? c as DeleteCommand : null;
  const note = [...intent, 'noteId', 'expectedRecordVersion'];
  if (!isId(c.noteId) || !isVersion(c.expectedRecordVersion)) return null;
  if (c.type === 'DuplicateNote' && exactKeys(c, note)) return c as ManageNote;
  if (c.type === 'ExcludeNote' && exactKeys(c, [...note, 'excluded']) && typeof c.excluded === 'boolean') return c as ManageNote;
  if (c.type === 'ReviewNote' && exactKeys(c, [...note, 'state', 'supersededById']) &&
      (c.state === 'superseded' ? isId(c.supersededById) : ['endorsed', 'needs_review'].includes(c.state as string) && c.supersededById === null)) return c as ManageNote;
  if (c.type === 'AddNoteSource' && exactKeys(c, [...note, 'source'])) {
    const s = c.source;
    if (exactKeys(s, ['kind', 'sourceId']) && s.kind === 'existing' && isId(s.sourceId)) return c as ManageNote;
    if (exactKeys(s, ['kind', 'captureId', 'revisionId', 'quote']) && s.kind === 'archive' && isId(s.captureId) && isId(s.revisionId) && typeof s.quote === 'string' && s.quote.isWellFormed() && !!s.quote.trim() && new TextEncoder().encode(s.quote).length <= 256 * 1024) return c as ManageNote;
  }
  return null;
}
