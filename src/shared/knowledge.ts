export const SCHEMA_VERSION = 1;
export const CANONICAL_VERSION = 1;
export const BACKUP_FORMAT_VERSION = 1;
export const RETRY_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_NOTE_BYTES = 256 * 1024;
export const NOTE_TYPES = ['idea', 'procedure', 'explanation', 'reference', 'personal_note'] as const;
export type NoteType = typeof NOTE_TYPES[number];
export type ReviewState = 'saved' | 'endorsed' | 'needs_review' | 'superseded';
export type Common = { id: string; schemaVersion: 1; createdAt: string; updatedAt: string; recordVersion: number };
export type NoteFields = {
  title: string; bodyMarkdown: string; type: NoteType; tags: string[];
  personalExplanation: string; applicableVersion: string; reviewAfter: string | null;
};
export type KnowledgeItem = Common & NoteFields & {
  plainText: string; contentHash: string; canonicalVersion: 1; currentVersion: number;
  reviewState: ReviewState; reviewedAt: string | null; supersededById: string | null;
  origin: 'manual_note' | 'manual_selection' | 'accepted_extraction'; sourceKind: 'manual' | 'captured' | 'pasted';
  curationKey: string | null; createdByRequestId: string;
  excluded?: boolean;
  undoSelectionEligible?: boolean;
};
export type KnowledgeRevision = {
  id: string; schemaVersion: 1; knowledgeId: string; version: number; changedAt: string;
  changeReason: 'created' | 'edited' | 'endorsed' | 'needs_review' | 'superseded' | 'source_added' | 'source_removed' | 'replacement_removed' | 'excluded' | 'included'; snapshot: KnowledgeItem;
  sources?: import('./archive').SourceRef[];
};
export type NoteSummary = Pick<KnowledgeItem, 'id' | 'title' | 'updatedAt' | 'recordVersion' | 'reviewState' | 'type'> & { preview: string };
export type HistoryEntry = Pick<KnowledgeRevision, 'version' | 'changedAt' | 'changeReason'>;
export type LibraryMeta = {
  id: 'library'; schemaVersion: 1; libraryId: string; generation: string; dataSeq: number;
  status: 'ready' | 'staging'; writeFence: null | { operationId: string; kind: 'restore' | 'delete' | 'migration' };
  deletion?: import('../storage/deletion').DeletionJob;
  restore?: { operationId: string; targetGeneration: string; phase: 'fenced' };
};
export type SaveResult = { requestId: string; generation: string; knowledgeId: string; recordVersion: number; dataSeq: number; warnings: string[]; deduplicated: boolean; created?: boolean; removed?: boolean; retainedSources?: number };
export type RequestReceipt = {
  requestId: string; generation: string; command: 'SaveManualNote' | 'CurateSelection' | 'UndoSelection' | 'EndorseSelection' | import('./management').ManageNote['type'] | 'DeleteLibraryData'; payloadDigest: string;
  issuedAt: string; createdAt: string; expiresAt: number; result: SaveResult; invalidated: boolean;
  caller?: import('./curation').CurationOwner;
};
export type SaveManualNote = {
  protocolVersion: 1; type: 'SaveManualNote'; requestId: string; issuedAt: string; generation: string;
  noteId: string | null; expectedRecordVersion: number | null; fields: NoteFields;
};
export type LibraryCommand = SaveManualNote
  | { protocolVersion: 1; type: 'ListNotes'; offset: number }
  | { protocolVersion: 1; type: 'GetNote'; generation: string; noteId: string; historyOffset: number }
  | { protocolVersion: 1; type: 'GetNoteRevision'; generation: string; noteId: string; version: number };
export type LibraryReply =
  | { ok: true; library: { generation: string; dataSeq: number; total: number; notes: NoteSummary[] } }
  | { ok: true; note: KnowledgeItem; history: HistoryEntry[]; dataSeq: number; sources: import('./archive').SourceRef[] }
  | { ok: true; revision: KnowledgeRevision }
  | { ok: true; result: SaveResult }
  | { ok: false; code: string; message: string; retryable: boolean };

export class KnowledgeError extends Error {
  constructor(public code: string) { super(code); }
}
export function fail(code: string): never { throw new KnowledgeError(code); }
export const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const isVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export const isIso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.isWellFormed() && new TextEncoder().encode(value).length <= max;
}
export function validFields(value: unknown): value is NoteFields {
  if (!exactKeys(value, ['title', 'bodyMarkdown', 'type', 'tags', 'personalExplanation', 'applicableVersion', 'reviewAfter'])) return false;
  return boundedText(value.title, 1000) && boundedText(value.bodyMarkdown, MAX_NOTE_BYTES) && !!value.bodyMarkdown.trim() &&
    NOTE_TYPES.includes(value.type as NoteType) && Array.isArray(value.tags) && value.tags.length <= 32 &&
    Array.from(value.tags).every(tag => boundedText(tag, 100) && tag.trim() === tag && !!tag) && new Set(value.tags).size === value.tags.length &&
    boundedText(value.personalExplanation, 16 * 1024) && boundedText(value.applicableVersion, 500) &&
    (value.reviewAfter === null || (typeof value.reviewAfter === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.reviewAfter) &&
      Number.isFinite(Date.parse(value.reviewAfter)) && new Date(value.reviewAfter).toISOString().slice(0, 10) === value.reviewAfter));
}
export function parseLibraryCommand(value: unknown): LibraryCommand | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.protocolVersion !== 1) return null;
  const offset = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 1_000_000;
  if (v.type === 'ListNotes' && exactKeys(v, ['protocolVersion', 'type', 'offset']) && offset(v.offset)) return v as LibraryCommand;
  if (v.type === 'GetNote' && exactKeys(v, ['protocolVersion', 'type', 'generation', 'noteId', 'historyOffset']) && isId(v.generation) && isId(v.noteId) && offset(v.historyOffset)) return v as LibraryCommand;
  if (v.type === 'GetNoteRevision' && exactKeys(v, ['protocolVersion', 'type', 'generation', 'noteId', 'version']) && isId(v.generation) && isId(v.noteId) && isVersion(v.version)) return v as LibraryCommand;
  if (v.type === 'SaveManualNote' && exactKeys(v, ['protocolVersion', 'type', 'requestId', 'issuedAt', 'generation', 'noteId', 'expectedRecordVersion', 'fields']) &&
      isId(v.requestId) && isIso(v.issuedAt) && isId(v.generation) && validFields(v.fields) &&
      ((v.noteId === null && v.expectedRecordVersion === null) || (isId(v.noteId) && isVersion(v.expectedRecordVersion)))) return v as LibraryCommand;
  return null;
}

// Canonical JSON v1: sorted object keys, ordered arrays, exact Unicode/whitespace;
// reject undefined/non-finite values rather than silently changing the digest.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return fail('INVALID_CANONICAL_VALUE');
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ canonicalVersion: CANONICAL_VERSION, value }));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

const messages: Record<string, string> = {
  BACKUP_TOO_LARGE: 'The uncompressed backup exceeds the 200 MiB ceiling. Nothing was truncated or replaced.',
  BACKUP_INVALID: 'This backup failed format, record, history or relationship validation. The active library is unchanged.',
  BACKUP_CHECKSUM: 'A backup section checksum does not match. The active library is unchanged.',
  BACKUP_TOO_NEW: 'This backup requires a newer extension. No data was replaced.',
  CAPTURE_ACTIVE: 'A loaded capture is still in progress. Finish or explicitly stop it before backup or restore.',
  LIBRARY_NOT_EMPTY: 'This library contains saved records. Review Replace library instead.',
  RESTORE_PENDING: 'A restore preview or cleanup is pending. Cancel it or resume maintenance first.',
  RESTORE_EXPIRED: 'The restore preview expired or the worker restarted. Choose the backup again.',
  TRANSFER_EXPIRED: 'The file transfer expired or the worker restarted. Choose the file or export again.',
  CLEANUP_BLOCKED: 'Another database handle is blocking cleanup. A previous or staging library copy remains. Close other extension views, then resume maintenance.',
  PREVIEW_CHANGED: 'The library changed since this deletion preview. Review a fresh preview before confirming.',
  SUPERSESSION_CYCLE: 'A note cannot replace itself or create a cycle of replacements.',
  SOURCE_MISMATCH: 'That source or exact quote is unavailable or ambiguous. Review the source again.',
  VIEWS_BUSY: 'An open library view has not cleared its content. Close or reload it, then retry deletion.',
  SEARCH_CHANGED: 'The library changed while searching. Rebuilding from current saved notes.',
  TEMPORARY_ALLOW_REQUIRED: 'This temporary conversation needs explicit allowance before a local copy can be saved.',
  PERMISSION_DENIED: 'ChatGPT access is disabled or unavailable. No new write was admitted.',
  NAVIGATION_CHANGED: 'The originating conversation or document changed. Check the library for any previously confirmed save.',
  PROVIDER_STATE_CHANGED: 'ChatGPT access changed. Start a new selection action.',
  UNAUTHORIZED_CONTEXT: 'This context cannot access that selection request.',
  UNDO_NOT_CREATED: 'Already saved items are not owned by this action and cannot be undone.',
  UNDO_CHANGED: 'This note changed after saving. Undo cannot remove it.',
  PAYLOAD_TOO_LARGE: 'This selection exceeds the capture limit. Select a smaller passage; nothing is truncated.',
  INVALID_COMMAND: 'The note request is invalid or exceeds a field limit. Your draft is unchanged.',
  STORAGE_FULL: 'Chrome could not allocate storage. Free space, then retry the same save. Your draft is unchanged.',
  WRITE_FAILED: 'The save could not be confirmed. Retry the same save; it will not create a duplicate.',
  VERSION_CONFLICT: 'Another view changed this note. Compare the latest saved version with your draft before saving again.',
  REQUEST_ID_REUSED: 'This request ID belongs to a different save. Start a new save intent.',
  INTENT_EXPIRED: 'This save intent is older than 30 days or has an invalid clock. Start a new save intent.',
  GENERATION_CHANGED: 'The library changed. Your draft is unchanged. Reload the library before saving.',
  LIBRARY_BUSY: 'The library is in maintenance mode. Your draft is unchanged; retry when it finishes.',
  NOT_FOUND: 'This note or revision no longer exists. Your draft is unchanged.',
  RESULT_REMOVED: 'The original save was removed. Retrying cannot recreate it.',
  STORAGE_MISSING: 'The active library database is missing. No replacement was created.',
  SCHEMA_TOO_NEW: 'This library needs a newer extension. No data was reset.',
  STORAGE_UNAVAILABLE: 'The local library could not open. Retry or reload; no data was reset.',
  LIBRARY_CORRUPT: 'The local library failed an integrity check. No data was reset.',
};
export function libraryError(error: unknown): Extract<LibraryReply, { ok: false }> {
  const name = error instanceof Error ? error.name : '';
  const code = error instanceof KnowledgeError ? error.code : name === 'QuotaExceededError' ? 'STORAGE_FULL' : name === 'VersionError' ? 'SCHEMA_TOO_NEW' : name === 'OpenFailedError' || name === 'DatabaseClosedError' ? 'STORAGE_UNAVAILABLE' : 'WRITE_FAILED';
  return { ok: false, code, message: messages[code] ?? 'The library request failed. Your draft is unchanged.', retryable: ['STORAGE_FULL', 'WRITE_FAILED', 'STORAGE_UNAVAILABLE', 'LIBRARY_BUSY'].includes(code) };
}
