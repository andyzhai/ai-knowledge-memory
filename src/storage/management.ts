import { digest, fail, RETRY_HORIZON_MS, type KnowledgeItem, type KnowledgeRevision, type SaveResult } from '../shared/knowledge';
import { parseManagement, type ManageNote } from '../shared/management';
import type { SourceRef } from '../shared/archive';
import type { KnowledgeRepository } from './repository';

export function freshIntent(issuedAt: string) {
  const age = Date.now() - Date.parse(issuedAt);
  if (age >= RETRY_HORIZON_MS || age < -300_000) fail('INTENT_EXPIRED');
}
export async function snapshotSources(repo: KnowledgeRepository, noteId: string) {
  const sources = await repo.db.sourceRefs.where('knowledgeId').equals(noteId).toArray();
  await repo.db.knowledgeRevisions.where('knowledgeId').equals(noteId).filter(row => row.sources === undefined).modify({ sources });
}
export async function appendHistory(repo: KnowledgeRepository, note: KnowledgeItem, reason: KnowledgeRevision['changeReason']) {
  await snapshotSources(repo, note.id);
  const sources = await repo.db.sourceRefs.where('knowledgeId').equals(note.id).toArray();
  await repo.db.knowledgeItems.put(note);
  await repo.db.knowledgeRevisions.add({ id: crypto.randomUUID(), schemaVersion: 1, knowledgeId: note.id, version: note.currentVersion, changedAt: note.updatedAt, changeReason: reason, snapshot: note, sources });
}
export async function manageNote(repo: KnowledgeRepository, command: ManageNote): Promise<SaveResult> {
  if (!parseManagement(command)) fail('INVALID_COMMAND');
  if (command.generation !== repo.generation) fail('GENERATION_CHANGED');
  freshIntent(command.issuedAt);
  const payloadDigest = await digest(command), now = new Date().toISOString(), db = repo.db;
  return db.transaction('rw', db.tables, async () => {
    const meta = await repo.checkReady(true), prior = await db.requestReceipts.get(command.requestId);
    if (prior) {
      if (prior.command !== command.type || prior.payloadDigest !== payloadDigest) fail('REQUEST_ID_REUSED');
      if (prior.invalidated || !await db.knowledgeItems.get(prior.result.knowledgeId)) fail('RESULT_REMOVED');
      return { ...prior.result, deduplicated: true };
    }
    const current = await db.knowledgeItems.get(command.noteId);
    if (!current) fail('NOT_FOUND');
    if (current.recordVersion !== command.expectedRecordVersion) fail('VERSION_CONFLICT');
    if (current.recordVersion !== current.currentVersion || !await db.knowledgeRevisions.where('[knowledgeId+version]').equals([current.id, current.currentVersion]).first()) fail('LIBRARY_CORRUPT');
    await snapshotSources(repo, current.id);
    let note = { ...current, recordVersion: current.recordVersion + 1, currentVersion: current.currentVersion + 1, updatedAt: now };
    if (!Number.isSafeInteger(note.recordVersion)) fail('LIBRARY_CORRUPT');
    let reason: KnowledgeRevision['changeReason'] = 'edited';
    if (command.type === 'ReviewNote') {
      if (command.supersededById) {
        const seen = new Set([current.id]); let id: string | null = command.supersededById;
        while (id) {
          if (seen.has(id)) fail('SUPERSESSION_CYCLE'); seen.add(id);
          const next: KnowledgeItem | undefined = await db.knowledgeItems.get(id); if (!next) fail('NOT_FOUND'); id = next.supersededById;
        }
      }
      note.reviewState = command.state; note.supersededById = command.supersededById;
      note.reviewedAt = command.state === 'endorsed' ? now : null; reason = command.state;
    } else if (command.type === 'ExcludeNote') { note.excluded = command.excluded; reason = command.excluded ? 'excluded' : 'included'; }
    else if (command.type === 'DuplicateNote') {
      note = { ...current, id: crypto.randomUUID(), createdAt: now, updatedAt: now, recordVersion: 1, currentVersion: 1,
        curationKey: null, createdByRequestId: command.requestId, reviewState: 'saved', reviewedAt: null, supersededById: null, excluded: false, undoSelectionEligible: false };
      for (const source of await db.sourceRefs.where('knowledgeId').equals(current.id).toArray()) await db.sourceRefs.add({ ...source, id: crypto.randomUUID(), knowledgeId: note.id });
      reason = 'created';
    } else {
      const count = await db.sourceRefs.where('knowledgeId').equals(note.id).count();
      if (count >= 128) fail('TOO_MANY_SOURCES');
      let source: SourceRef;
      if (command.source.kind === 'existing') {
        const original = await db.sourceRefs.get(command.source.sourceId); if (!original) fail('NOT_FOUND');
        source = { ...original, id: crypto.randomUUID(), knowledgeId: note.id, fragmentOrder: count };
      } else {
        const { captureId, revisionId, quote } = command.source;
        const capture = await db.captures.get(captureId), revision = await db.messageRevisions.get(revisionId);
        if (!capture || capture.captureStatus === 'in_progress' || !capture.revisionIds.includes(revisionId) || !revision) fail('SOURCE_MISMATCH');
        const conversation = await db.conversations.get(capture.conversationId);
        const connection = conversation ? await db.connections.get(conversation.connectionId) : undefined;
        const start = revision.plainText.indexOf(quote);
        if (!conversation || !connection || start < 0 || revision.plainText.indexOf(quote, start + 1) >= 0) fail('SOURCE_MISMATCH');
        const point = Array.from(revision.plainText.slice(0, start)).length;
        source = { id: crypto.randomUUID(), schemaVersion: 1, knowledgeId: note.id, sourceKind: 'captured', exactText: quote,
          sourceProvider: connection.provider, sourceTitle: conversation.title, sourceUrl: conversation.canonicalUrl, capturedAt: capture.capturedAt,
          conversationId: conversation.id, captureId, revisionId, anchorStatus: 'resolved', anchor: { quote, start: point, end: point + Array.from(quote).length, extractorVersion: revision.extractorVersion },
          originalPageAnchor: null, fidelityWarnings: capture.warnings, sourceContentHash: revision.contentHash, sourceRemovedAt: null,
          fragmentOrder: count, sourceRole: revision.role, contentScope: revision.contentScope };
      }
      await db.sourceRefs.add(source); reason = 'source_added';
    }
    await appendHistory(repo, note, reason);
    const result: SaveResult = { requestId: command.requestId, generation: repo.generation, knowledgeId: note.id, recordVersion: note.recordVersion,
      dataSeq: meta.dataSeq + 1, warnings: [], deduplicated: false };
    await db.meta.put({ ...meta, dataSeq: result.dataSeq });
    await db.requestReceipts.where('expiresAt').belowOrEqual(Date.now()).delete();
    await db.requestReceipts.add({ requestId: command.requestId, generation: repo.generation, command: command.type, payloadDigest, issuedAt: command.issuedAt,
      createdAt: now, expiresAt: Date.parse(command.issuedAt) + RETRY_HORIZON_MS, result, invalidated: false });
    return result;
  });
}
