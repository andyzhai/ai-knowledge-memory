import { canonicalJson, digest, exactKeys, fail, isId, isIso, isVersion, validFields, KnowledgeError, type KnowledgeItem, type KnowledgeRevision } from './knowledge';
import { sourceHash, validAnchor, type Connection, type Conversation, type Message, type MessageRevision, type Capture, type SourceRef } from './archive';
import { validBlock } from './loaded-capture';
import { safeLink, markdownPlainText } from './markdown';

export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
export const TRANSFER_CHARS = 256 * 1024;
export const SECTIONS = ['connections', 'conversations', 'messages', 'messageRevisions', 'captures', 'knowledgeItems', 'sourceRefs', 'knowledgeRevisions'] as const;
export type Section = typeof SECTIONS[number];
// Operational capture ownership and retry logs are deliberately not portable.
export type PortableCapture = Omit<Capture, 'owner' | 'providerEpoch' | 'startDigest' | 'issuedAt' | 'navigationNonceDigest' | 'acceptedBatches' | 'nextExpectedBatch'>;
export type Records = { connections: Connection[]; conversations: Conversation[]; messages: Message[]; messageRevisions: MessageRevision[]; captures: PortableCapture[]; knowledgeItems: KnowledgeItem[]; sourceRefs: SourceRef[]; knowledgeRevisions: KnowledgeRevision[] };
export type Backup = { format: 'ai-knowledge-memory'; formatVersion: 1; schemaVersion: 1; canonicalVersion: 1; checksumVersion: 1; libraryId: string; exportedAt: string; dataSeq: number; counts: Record<Section, number>; checksums: Record<Section, string>; records: Records };
export type RestorePreview = { operationId: string; generation: string; dataSeq: number; currentCounts: Record<Section, number>; counts: Record<Section, number>; bytes: number; estimatedAdditionalBytes: number; availableBytes: number | null };
export function checkBackupSize(bytes: number) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BACKUP_BYTES) fail('BACKUP_TOO_LARGE'); }
// Scan depth before JSON.parse: deeply nested untrusted input never reaches a
// recursive canonicalizer. Strings, including escaped quotes, are skipped.
export function parseBackupText(text: string): unknown {
  checkBackupSize(new TextEncoder().encode(text).length);
  let depth = 0, quoted = false, escape = false;
  for (const c of text) {
    if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') { if (++depth > 32) fail('BACKUP_INVALID'); }
    else if (c === '}' || c === ']') { if (--depth < 0) fail('BACKUP_INVALID'); }
  }
  try { return JSON.parse(text, (key, value: unknown) => { if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('BACKUP_INVALID'); return value; }); }
  catch { return fail('BACKUP_INVALID'); }
}
const text = (v: unknown): v is string => typeof v === 'string' && v.isWellFormed();
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const one = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v);
const nullable = (v: unknown, test: (v: unknown) => boolean) => v === null || test(v);
const url = (v: unknown) => v === null || (text(v) && !!safeLink(v));
const strings = (v: unknown) => Array.isArray(v) && v.every(text);
function requireValid(value: unknown): asserts value { if (!value) fail('BACKUP_INVALID'); }
function keys(value: object, required: string, optional = '') {
  const r = required.split(' '), o = optional.split(' ');
  requireValid(r.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => r.includes(k) || o.includes(k)));
}
function common(v: Connection | Conversation | Message | KnowledgeItem | PortableCapture) {
  requireValid(v.schemaVersion === 1 && isId(v.id) && isIso(v.createdAt) && isIso(v.updatedAt) && isVersion(v.recordVersion));
}
const COMMON = 'id schemaVersion createdAt updatedAt recordVersion';
const NOTE = 'title bodyMarkdown type tags personalExplanation applicableVersion reviewAfter plainText contentHash canonicalVersion currentVersion reviewState reviewedAt supersededById origin sourceKind curationKey createdByRequestId';
function noteFields(n: KnowledgeItem) { const { title, bodyMarkdown, type, tags, personalExplanation, applicableVersion, reviewAfter } = n; return { title, bodyMarkdown, type, tags, personalExplanation, applicableVersion, reviewAfter }; }
async function validateNote(n: KnowledgeItem) {
  keys(n, `${COMMON} ${NOTE}`, 'excluded undoSelectionEligible'); common(n);
  requireValid(validFields(noteFields(n)) && text(n.plainText) && hash(n.contentHash) && n.canonicalVersion === 1 && n.currentVersion === n.recordVersion &&
    one(n.reviewState, ['saved', 'endorsed', 'needs_review', 'superseded']) && nullable(n.reviewedAt, isIso) && nullable(n.supersededById, isId) &&
    one(n.origin, ['manual_note', 'manual_selection', 'accepted_extraction']) && one(n.sourceKind, ['manual', 'captured', 'pasted']) && nullable(n.curationKey, hash) && isId(n.createdByRequestId) &&
    (n.excluded === undefined || typeof n.excluded === 'boolean') && (n.undoSelectionEligible === undefined || typeof n.undoSelectionEligible === 'boolean'));
  // Initial selections use the original selection digest; edits use note fields.
  const selection = await digest({ kind: 'selection', selectedText: n.bodyMarkdown });
  requireValid(n.contentHash === await digest({ kind: 'knowledge', fields: noteFields(n) }) || (n.origin === 'manual_selection' && n.contentHash === selection));
  requireValid(n.plainText === markdownPlainText(n.bodyMarkdown) || (n.origin === 'manual_selection' && n.contentHash === selection && n.plainText === n.bodyMarkdown));
}
export async function makeBackup(records: Records, libraryId: string, dataSeq: number): Promise<Backup> {
  const counts = {} as Backup['counts'], checksums = {} as Backup['checksums'];
  for (const section of SECTIONS) { counts[section] = records[section].length; checksums[section] = await digest(records[section]); }
  return { format: 'ai-knowledge-memory', formatVersion: 1, schemaVersion: 1, canonicalVersion: 1, checksumVersion: 1, libraryId, exportedAt: new Date().toISOString(), dataSeq, counts, checksums, records };
}
export async function validateBackup(value: unknown): Promise<Backup> {
  try { return await validateRecords(value); } catch (error) { if (error instanceof KnowledgeError) throw error; return fail('BACKUP_INVALID'); }
}
async function validateRecords(value: unknown): Promise<Backup> {
  requireValid(value && typeof value === 'object');
  const b = value as Backup;
  if (b.schemaVersion > 1 || b.formatVersion > 1 || b.canonicalVersion > 1 || b.checksumVersion > 1) fail('BACKUP_TOO_NEW');
  requireValid(exactKeys(b, ['format', 'formatVersion', 'schemaVersion', 'canonicalVersion', 'checksumVersion', 'libraryId', 'exportedAt', 'dataSeq', 'counts', 'checksums', 'records']) &&
    b.format === 'ai-knowledge-memory' && b.formatVersion === 1 && b.schemaVersion === 1 && b.canonicalVersion === 1 && b.checksumVersion === 1 && isId(b.libraryId) && isIso(b.exportedAt) && integer(b.dataSeq) &&
    exactKeys(b.records, [...SECTIONS]) && exactKeys(b.counts, [...SECTIONS]) && exactKeys(b.checksums, [...SECTIONS]));
  const ids = new Set<string>();
  for (const s of SECTIONS) {
    requireValid(Array.isArray(b.records[s]) && b.counts[s] === b.records[s].length && hash(b.checksums[s]));
    for (const r of b.records[s]) { requireValid(r && typeof r === 'object' && isId(r.id) && r.schemaVersion === 1 && !ids.has(r.id)); ids.add(r.id); }
    if (await digest(b.records[s]) !== b.checksums[s]) fail('BACKUP_CHECKSUM');
  }
  const r = b.records;
  const connections = new Map(r.connections.map(x => [x.id, x])), conversations = new Map(r.conversations.map(x => [x.id, x]));
  const messages = new Map(r.messages.map(x => [x.id, x])), revisions = new Map(r.messageRevisions.map(x => [x.id, x]));
  const captures = new Map(r.captures.map(x => [x.id, x])), notes = new Map(r.knowledgeItems.map(x => [x.id, x]));
  const unique = (values: string[]) => requireValid(new Set(values).size === values.length);
  unique(r.connections.map(x => x.provider)); unique(r.conversations.map(x => `${x.connectionId}:${x.identityKey}`));
  unique(r.messages.filter(x => x.sourceMessageId !== null).map(x => `${x.conversationId}:${x.sourceMessageId}`));
  unique(r.messageRevisions.map(x => `${x.messageId}:${x.contentHash}`)); unique(r.knowledgeItems.filter(x => x.curationKey !== null).map(x => x.curationKey!));
  unique(r.knowledgeRevisions.map(x => `${x.knowledgeId}:${x.version}`));
  for (const c of r.connections) {
    keys(c, `${COMMON} provider namespace enabled capturePolicy accountRef`); common(c);
    requireValid(one(c.provider, ['chatgpt', 'gemini', 'perplexity']) && text(c.namespace) && typeof c.enabled === 'boolean' && c.capturePolicy === 'manual' && c.accountRef === null);
  }
  for (const c of r.conversations) {
    keys(c, `${COMMON} connectionId identityKey identityQuality canonicalUrl title sourceKind providerConversationId latestCaptureId lastCapturedAt temporaryStatus`, 'createdByRequestId'); common(c);
    requireValid(connections.has(c.connectionId) && text(c.identityKey) && one(c.identityQuality, ['provider', 'url', 'session']) && url(c.canonicalUrl) && text(c.title) && one(c.sourceKind, ['captured', 'pasted']) && nullable(c.providerConversationId, text) && isIso(c.lastCapturedAt) && one(c.temporaryStatus, ['temporary', 'ordinary', 'unknown']) &&
      (c.createdByRequestId === undefined || isId(c.createdByRequestId)) && (c.latestCaptureId === null || captures.get(c.latestCaptureId)?.conversationId === c.id));
  }
  for (const m of r.messages) {
    keys(m, `${COMMON} conversationId sourceMessageId identityQuality contentScope originMessageLocator latestObservedRevisionId`, 'createdByRequestId independentlyRetained'); common(m);
    requireValid(conversations.has(m.conversationId) && nullable(m.sourceMessageId, text) && one(m.identityQuality, ['provider', 'matched', 'unknown']) && one(m.contentScope, ['message', 'excerpt']) && nullable(m.originMessageLocator, text) &&
      (m.latestObservedRevisionId === null || revisions.get(m.latestObservedRevisionId)?.messageId === m.id) && (m.createdByRequestId === undefined || isId(m.createdByRequestId)) && (m.independentlyRetained === undefined || typeof m.independentlyRetained === 'boolean'));
  }
  for (const v of r.messageRevisions) {
    keys(v, 'id schemaVersion messageId role contentScope blocks plainText contentHash canonicalVersion observedAt completion extractorVersion sourceCreatedAt language parentSourceMessageId');
    requireValid(messages.has(v.messageId) && v.contentScope === messages.get(v.messageId)?.contentScope && one(v.role, ['user', 'assistant', 'system', 'tool', 'unknown']) && Array.isArray(v.blocks) && v.blocks.length > 0 && v.blocks.every(validBlock) &&
      v.plainText === v.blocks.map(x => x.text).filter(Boolean).join('\n\n') && v.canonicalVersion === 1 && isIso(v.observedAt) && one(v.completion, ['complete', 'partial', 'unknown']) && text(v.extractorVersion) && nullable(v.sourceCreatedAt, isIso) && nullable(v.language, text) && nullable(v.parentSourceMessageId, text));
    requireValid(v.contentHash === await sourceHash(v.contentScope, v.role, v.blocks));
    for (const block of v.blocks) if ('url' in block) requireValid(url(block.url));
  }
  for (const c of r.captures) {
    keys(c, `${COMMON} conversationId revisionIds membership scope historyCoverage branchCoverage warnings capturedAt adapterVersion captureStatus requestId createdByRequestId independentlyRetained sessionId declaredTotals`, 'branchObservation interruptionReason'); common(c);
    requireValid(conversations.has(c.conversationId) && Array.isArray(c.revisionIds) && c.revisionIds.every(id => messages.get(revisions.get(id)?.messageId ?? '')?.conversationId === c.conversationId) && Array.isArray(c.membership) && c.membership.length === c.revisionIds.length &&
      c.membership.every((m, i) => exactKeys(m, ['revisionId', 'completion', 'observedAt', 'extractorVersion']) && m.revisionId === c.revisionIds[i] && one(m.completion, ['complete', 'partial', 'unknown']) && isIso(m.observedAt) && text(m.extractorVersion)) &&
      one(c.scope, ['selection', 'loaded_conversation']) && one(c.historyCoverage, ['loaded_only', 'unknown']) && one(c.branchCoverage, ['visible_branch', 'unknown']) && strings(c.warnings) && isIso(c.capturedAt) && text(c.adapterVersion) && one(c.captureStatus, ['completed', 'interrupted']) && isId(c.requestId) && isId(c.createdByRequestId) && isId(c.sessionId) && typeof c.independentlyRetained === 'boolean' &&
      (c.declaredTotals === null || (exactKeys(c.declaredTotals, ['batches', 'messages']) && integer(c.declaredTotals.batches) && integer(c.declaredTotals.messages))) && (c.interruptionReason === undefined || text(c.interruptionReason)));
    if (c.scope === 'loaded_conversation') {
      unique(c.revisionIds);
      requireValid(c.declaredTotals !== null && c.revisionIds.length <= c.declaredTotals.messages && (c.captureStatus !== 'completed' || c.revisionIds.length === c.declaredTotals.messages));
    }
    if (c.branchObservation !== undefined) requireValid(exactKeys(c.branchObservation, ['messageIds', 'signature']) && Array.isArray(c.branchObservation.messageIds) && c.branchObservation.messageIds.every(x => nullable(x, text)) && hash(c.branchObservation.signature));
  }
  const sourceOwners = new Map<string, string>();
  function source(s: SourceRef, noteId: string) {
    keys(s, 'id schemaVersion knowledgeId sourceKind exactText sourceProvider sourceTitle capturedAt sourceUrl conversationId captureId revisionId anchorStatus anchor originalPageAnchor fidelityWarnings sourceContentHash sourceRemovedAt', 'fragmentOrder sourceRole contentScope blockKind temporaryStatus');
    requireValid(isId(s.id) && s.schemaVersion === 1 && s.knowledgeId === noteId && notes.has(noteId) && one(s.sourceKind, ['captured', 'pasted']) && text(s.exactText) && nullable(s.sourceProvider, x => one(x, ['chatgpt', 'gemini', 'perplexity'])) && text(s.sourceTitle) && isIso(s.capturedAt) && url(s.sourceUrl) && one(s.anchorStatus, ['resolved', 'unresolved', 'ambiguous']) && strings(s.fidelityWarnings) && nullable(s.sourceContentHash, hash) && nullable(s.sourceRemovedAt, isIso));
    requireValid(!sourceOwners.has(s.id) || sourceOwners.get(s.id) === noteId); sourceOwners.set(s.id, noteId);
    if (s.revisionId !== null) {
      const v = revisions.get(s.revisionId), c = captures.get(s.captureId ?? '');
      requireValid(v && c && c.conversationId === s.conversationId && c.revisionIds.includes(v.id) && messages.get(v.messageId)?.conversationId === s.conversationId && s.sourceContentHash === v.contentHash && s.sourceRemovedAt === null);
      requireValid(s.sourceProvider === connections.get(conversations.get(c.conversationId)!.connectionId)?.provider && (s.anchorStatus !== 'resolved' || s.anchor !== null));
      if (s.anchor !== null) requireValid(exactKeys(s.anchor, ['quote', 'start', 'end', 'extractorVersion']) && validAnchor(v.plainText, s.anchor) && s.anchor.quote === s.exactText);
    } else requireValid(s.conversationId === null && s.captureId === null);
    if (s.anchor !== null) requireValid(exactKeys(s.anchor, ['quote', 'start', 'end', 'extractorVersion']) && text(s.anchor.quote) && integer(s.anchor.start) && integer(s.anchor.end) && s.anchor.end > s.anchor.start && text(s.anchor.extractorVersion));
    if (s.originalPageAnchor !== null) { const a = s.originalPageAnchor; requireValid(exactKeys(a, ['quote', 'start', 'end', 'extractorVersion', 'locator', 'prefix', 'suffix']) && text(a.quote) && integer(a.start) && integer(a.end) && a.end - a.start === Array.from(a.quote).length && text(a.extractorVersion) && nullable(a.locator, text) && text(a.prefix) && text(a.suffix)); }
    requireValid((s.fragmentOrder === undefined || integer(s.fragmentOrder)) && (s.sourceRole === undefined || one(s.sourceRole, ['user', 'assistant', 'system', 'tool', 'unknown'])) && (s.contentScope === undefined || one(s.contentScope, ['message', 'excerpt'])) && (s.blockKind === undefined || one(s.blockKind, ['text', 'code'])) && (s.temporaryStatus === undefined || one(s.temporaryStatus, ['temporary', 'unknown'])));
  }
  for (const n of r.knowledgeItems) { await validateNote(n); if (n.supersededById !== null) requireValid(notes.has(n.supersededById)); }
  const visited = new Set<string>();
  for (const n of r.knowledgeItems) { const seen = new Set<string>(); let next: KnowledgeItem | undefined = n; while (next && !visited.has(next.id)) { requireValid(!seen.has(next.id)); seen.add(next.id); next = notes.get(next.supersededById ?? ''); } for (const id of seen) visited.add(id); }
  for (const s of r.sourceRefs) source(s, s.knowledgeId);
  const histories = new Map<string, KnowledgeRevision[]>();
  for (const h of r.knowledgeRevisions) {
    keys(h, 'id schemaVersion knowledgeId version changedAt changeReason snapshot', 'sources');
    requireValid(notes.has(h.knowledgeId) && isVersion(h.version) && isIso(h.changedAt) && one(h.changeReason, ['created', 'edited', 'endorsed', 'needs_review', 'superseded', 'source_added', 'source_removed', 'replacement_removed', 'excluded', 'included']) && h.snapshot && h.snapshot.id === h.knowledgeId && h.snapshot.currentVersion === h.version);
    await validateNote(h.snapshot);
    if (h.snapshot.supersededById !== null) requireValid(notes.has(h.snapshot.supersededById));
    if (h.sources !== undefined) { requireValid(Array.isArray(h.sources)); unique(h.sources.map(s => s.id)); for (const s of h.sources) source(s, h.knowledgeId); }
    const entries = histories.get(h.knowledgeId) ?? []; entries.push(h); histories.set(h.knowledgeId, entries);
  }
  const currentSources = new Map<string, SourceRef[]>();
  for (const s of r.sourceRefs) { const rows = currentSources.get(s.knowledgeId) ?? []; rows.push(s); currentSources.set(s.knowledgeId, rows); }
  for (const n of r.knowledgeItems) {
    const history = (histories.get(n.id) ?? []).sort((a, b) => a.version - b.version);
    requireValid(history.length === n.currentVersion && history.every((h, i) => h.version === i + 1) && canonicalJson(history.at(-1)!.snapshot) === canonicalJson(n));
    const latest = history.at(-1)!;
    if (latest.sources !== undefined) requireValid(canonicalJson([...latest.sources].sort((a, b) => a.id.localeCompare(b.id))) === canonicalJson((currentSources.get(n.id) ?? []).sort((a, b) => a.id.localeCompare(b.id))));
  }
  return b;
}

export function markdownFile(note: KnowledgeItem, sources: SourceRef[]) {
  const filename = `${note.title.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'note'}-${note.id}.md`;
  const metadata = { id: note.id, title: note.title, type: note.type, tags: note.tags, reviewState: note.reviewState, reviewedAt: note.reviewedAt, reviewAfter: note.reviewAfter, applicableVersion: note.applicableVersion, supersededById: note.supersededById, excluded: note.excluded ?? false };
  const fence = (value: string) => { const delimiter = '`'.repeat(Math.max(3, ...Array.from(value.matchAll(/`+/g), m => m[0].length + 1))); return `${delimiter}text\n${value}\n${delimiter}`; };
  const body = `---\n${Object.entries(metadata).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${note.bodyMarkdown}\n\n## Personal explanation\n\n${note.personalExplanation}\n\n## Sources and caveats\n\nSaved does not mean endorsed. Coverage is limited to the observed excerpt or loaded conversation; earlier history and other branches may be absent. This Markdown is a one-way export, not a full backup.\n\n${sources.map(s => `### ${s.sourceTitle.replace(/[\r\n]/g, ' ')}\n\nSource ID: ${s.id}\nProvider: ${s.sourceProvider ?? 'pasted'}\nCaptured: ${s.capturedAt}\nURL: ${s.sourceUrl ?? 'unavailable'}\nArchive removed: ${s.sourceRemovedAt ?? 'no'}\nFidelity: ${s.fidelityWarnings.join(', ') || 'no additional warnings'}\n\n${fence(s.exactText)}`).join('\n\n')}\n`;
  return { filename, body };
}
// ZIP STORE: UTF-8 filenames, no compression/dependency, CRC32 per file.
export function markdownZip(files: { filename: string; body: string }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder(), chunks: Uint8Array[] = [], directory: Uint8Array[] = []; let offset = 0;
  const header = (size: number) => new DataView(new ArrayBuffer(size));
  for (const f of files) {
    const name = encoder.encode(f.filename), body = encoder.encode(f.body); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } crc = (crc ^ 0xffffffff) >>> 0;
    const local = header(30 + name.length); local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x800, true); local.setUint32(14, crc, true); local.setUint32(18, body.length, true); local.setUint32(22, body.length, true); local.setUint16(26, name.length, true); new Uint8Array(local.buffer).set(name, 30);
    const central = header(46 + name.length); central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, 0x800, true); central.setUint32(16, crc, true); central.setUint32(20, body.length, true); central.setUint32(24, body.length, true); central.setUint16(28, name.length, true); central.setUint32(42, offset, true); new Uint8Array(central.buffer).set(name, 46);
    // DOS date 1980-01-01 is the deterministic minimum valid ZIP timestamp.
    local.setUint16(12, 0x21, true); central.setUint16(14, 0x21, true);
    chunks.push(new Uint8Array(local.buffer), body); directory.push(new Uint8Array(central.buffer)); offset += local.byteLength + body.length;
  }
  const size = directory.reduce((n, x) => n + x.length, 0), end = header(22); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true);
  requireValid(files.length <= 65535); const result = new Uint8Array(offset + size + 22); let cursor = 0;
  for (const chunk of [...chunks, ...directory, new Uint8Array(end.buffer)]) { result.set(chunk, cursor); cursor += chunk.length; } return result;
}
