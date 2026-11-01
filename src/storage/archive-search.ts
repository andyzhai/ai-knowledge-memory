import { fail, type KnowledgeItem } from '../shared/knowledge';
import type { Capture, CaptureMembership } from '../shared/archive';
import type { SearchReadCommand, SearchReadReply } from '../shared/search-access';
import type { SearchDocument } from '../shared/search';
import type { KnowledgeRepository } from './repository';

export async function readArchiveSearch(repo: KnowledgeRepository, command: SearchReadCommand): Promise<SearchReadReply> {
  const db = repo.db;
  return db.transaction('r', [db.meta, db.captures, db.messageRevisions, db.conversations, db.connections], async () => {
    const meta = await repo.checkReady(), marker = { generation: repo.generation, dataSeq: meta.dataSeq };
    if ('marker' in command && (command.marker.generation !== marker.generation || command.marker.dataSeq !== marker.dataSeq)) fail('SEARCH_CHANGED');
    // Capture membership is authoritative. A later excerpt or incomplete loaded
    // branch cannot erase retained messages. In-progress data is never eligible.
    const captures = await db.captures.filter(c => c.captureStatus !== 'in_progress').toArray();
    const observations = new Map<string, { capture: Capture; member: CaptureMembership; order: string }>();
    for (const capture of captures) for (const member of capture.membership) {
      const order = `${member.observedAt}:${capture.capturedAt}:${capture.id}`;
      if ((observations.get(member.revisionId)?.order ?? '') < order) observations.set(member.revisionId, { capture, member, order });
    }
    const revisions = await db.messageRevisions.bulkGet([...observations.keys()]);
    const latest = new Map<string, { id: string; order: string }>();
    for (const revision of revisions) {
      if (!revision) fail('LIBRARY_CORRUPT');
      const order = observations.get(revision.id)!.order;
      if ((latest.get(revision.messageId)?.order ?? '') < order) latest.set(revision.messageId, { id: revision.id, order });
    }
    if (command.type === 'GetArchiveSearchState') return { ok: true, marker, total: revisions.length };
    const eligible = revisions.filter(r => r && ('ids' in command ? command.ids.includes(r.id) : 'afterId' in command && (!command.afterId || r.id > command.afterId))).sort((a, b) => a!.id.localeCompare(b!.id, 'en'));
    const documents: SearchDocument[] = []; let bytes = 0;
    for (const revision of eligible) {
      if (!revision) continue;
      const { capture, member } = observations.get(revision.id)!;
      const conversation = await db.conversations.get(capture.conversationId);
      if (!conversation) fail('LIBRARY_CORRUPT');
      const connection = await db.connections.get(conversation.connectionId);
      if (!connection) fail('LIBRARY_CORRUPT');
      // Read-only projection into the existing lexical engine; never persisted
      // as Knowledge and never eligible for the Knowledge-only H prototype.
      const note: KnowledgeItem = { id: revision.id, schemaVersion: 1, createdAt: capture.capturedAt, updatedAt: capture.updatedAt, recordVersion: capture.recordVersion,
        title: conversation.title, bodyMarkdown: revision.plainText, plainText: revision.plainText, contentHash: revision.contentHash, canonicalVersion: 1,
        currentVersion: 1, type: 'reference', tags: [], personalExplanation: '', applicableVersion: '', reviewAfter: null, reviewState: 'saved', reviewedAt: null,
        supersededById: null, origin: 'manual_selection', sourceKind: 'captured', curationKey: null, createdByRequestId: capture.requestId };
      const document: SearchDocument = { note, providers: [connection.provider], archive: { conversationId: conversation.id, captureId: capture.id, messageId: revision.messageId,
        revisionId: revision.id, title: conversation.title, latest: latest.get(revision.messageId)?.id === revision.id,
        status: capture.captureStatus as 'completed' | 'interrupted', completion: member.completion, role: revision.role, scope: revision.contentScope } };
      const size = new TextEncoder().encode(JSON.stringify(document)).length;
      if ('afterId' in command && documents.length && (bytes + size > 1024 * 1024 || documents.length >= 32)) break;
      documents.push(document); bytes += size;
    }
    return { ok: true, marker, documents, nextId: 'afterId' in command && documents.length ? documents.at(-1)!.note.id : null };
  });
}
