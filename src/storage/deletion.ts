import { canonicalJson, digest, fail, RETRY_HORIZON_MS, type SaveResult } from '../shared/knowledge';
import type { DeleteCommand, DeleteTarget, DeletionPreview } from '../shared/management';
import type { SourceRef } from '../shared/archive';
import type { KnowledgeRepository } from './repository';
import { appendHistory, freshIntent, snapshotSources } from './management';
import type { Table } from 'dexie';

type Confirm = Extract<DeleteCommand, { type: 'DeleteLibraryData' }>;
const deletionOrder = ['sourceRefs', 'knowledgeRevisions', 'knowledgeItems', 'captures', 'messageRevisions', 'messages', 'conversations', 'connections'] as const;
type DeleteTable = typeof deletionOrder[number];
export type DeletionJob = { command: Confirm; payloadDigest: string; remaining: Record<DeleteTable, string[]>; result: SaveResult };
async function metadata<T, U>(table: Table<T, string>, project: (row: T) => U): Promise<U[]> {
  const rows: U[] = []; await table.each(row => { rows.push(project(row)); }); return rows;
}

// The preview and the confirmed plan use the same dependency traversal in one
// consistent transaction. Titles are returned to the UI, never kept in a job.
async function plan(repo: KnowledgeRepository, target: DeleteTarget) {
  const db = repo.db, meta = await repo.checkReady();
  const [notes, histories, sources, captures, messages, revisions, conversations, connections] = await Promise.all([
    metadata(db.knowledgeItems, ({ id, title, supersededById }) => ({ id, title, supersededById })),
    metadata(db.knowledgeRevisions, ({ id, knowledgeId, sources }) => ({ id, knowledgeId, conversationIds: sources?.flatMap(s => s.conversationId ? [s.conversationId] : []) ?? [] })),
    metadata(db.sourceRefs, ({ id, knowledgeId, conversationId, captureId, revisionId }) => ({ id, knowledgeId, conversationId, captureId, revisionId })), db.captures.toArray(),
    db.messages.toArray(), metadata(db.messageRevisions, ({ id, messageId }) => ({ id, messageId })), db.conversations.toArray(), db.connections.toArray(),
  ]);
  const conversationIds = new Set<string>(), noteIds = new Set<string>();
  if (target.kind === 'all') { conversations.forEach(c => conversationIds.add(c.id)); notes.forEach(n => noteIds.add(n.id)); }
  if (target.kind === 'note') { if (!notes.some(n => n.id === target.noteId)) fail('NOT_FOUND'); noteIds.add(target.noteId); }
  if (target.kind === 'conversation') {
    if (!conversations.some(c => c.id === target.conversationId)) fail('NOT_FOUND'); conversationIds.add(target.conversationId);
  }
  if (target.kind === 'archive_filter') {
    for (const c of conversations) {
      const provider = connections.find(connection => connection.id === c.connectionId)?.provider;
      if ((!target.provider || target.provider === provider) && c.lastCapturedAt.slice(0, 10) <= target.through) conversationIds.add(c.id);
    }
  }
  if (target.kind === 'conversation' && target.mode === 'with_knowledge') {
    for (const s of sources) if (s.conversationId && conversationIds.has(s.conversationId)) noteIds.add(s.knowledgeId);
    for (const h of histories) if (h.conversationIds.some(id => conversationIds.has(id))) noteIds.add(h.knowledgeId);
  }
  const captureIds = new Set(captures.filter(c => conversationIds.has(c.conversationId)).map(c => c.id));
  const revisionById = new Map(revisions.map(r => [r.id, r])), messageById = new Map(messages.map(m => [m.id, m]));
  // Note deletion collects only its exclusive, unmodified selection evidence.
  // Independent captures, shared sources, and full message retention survive.
  for (const c of captures) {
    const references = sources.filter(s => s.captureId === c.id);
    if (c.scope === 'selection' && !c.independentlyRetained && c.recordVersion === 1 && references.length && references.every(s => noteIds.has(s.knowledgeId)) &&
        !c.revisionIds.some(id => messageById.get(revisionById.get(id)?.messageId ?? '')?.independentlyRetained)) captureIds.add(c.id);
  }
  const revisionIds = new Set<string>(), messageIds = new Set<string>();
  for (const m of messages) {
    const candidates = revisions.filter(r => r.messageId === m.id);
    const forced = conversationIds.has(m.conversationId);
    if (forced || (!m.independentlyRetained && candidates.every(r => !sources.some(s => s.revisionId === r.id && !noteIds.has(s.knowledgeId)) &&
        !captures.some(c => !captureIds.has(c.id) && c.revisionIds.includes(r.id))))) {
      // Do not garbage-collect unrelated orphan records as a side effect.
      if (forced || candidates.some(r => captures.some(c => captureIds.has(c.id) && c.revisionIds.includes(r.id)))) {
        messageIds.add(m.id); candidates.forEach(r => revisionIds.add(r.id));
      }
    }
  }
  for (const c of conversations) {
    if (captures.some(cap => cap.conversationId === c.id && captureIds.has(cap.id)) &&
        !captures.some(cap => cap.conversationId === c.id && !captureIds.has(cap.id)) && !messages.some(m => m.conversationId === c.id && !messageIds.has(m.id)) &&
        !sources.some(s => s.conversationId === c.id && !noteIds.has(s.knowledgeId))) conversationIds.add(c.id);
  }
  const detached = sources.filter(s => !noteIds.has(s.knowledgeId) && s.conversationId && conversationIds.has(s.conversationId));
  const affected = notes.filter(n => !noteIds.has(n.id) && (detached.some(s => s.knowledgeId === n.id) || (n.supersededById && noteIds.has(n.supersededById))));
  const remaining: Record<DeleteTable, string[]> = {
    knowledgeItems: [...noteIds], knowledgeRevisions: histories.filter(h => noteIds.has(h.knowledgeId)).map(h => h.id),
    sourceRefs: sources.filter(s => noteIds.has(s.knowledgeId)).map(s => s.id), captures: [...captureIds], messages: [...messageIds], messageRevisions: [...revisionIds],
    conversations: [...conversationIds], connections: connections.filter(c => conversations.some(v => v.connectionId === c.id && conversationIds.has(v.id)) &&
      !conversations.some(v => v.connectionId === c.id && !conversationIds.has(v.id))).map(c => c.id),
  };
  if (target.kind === 'all') {
    // Reset also removes orphaned rows and abandoned data, not only the graph
    // reachable from currently valid notes/conversations.
    remaining.knowledgeRevisions = histories.map(h => h.id); remaining.sourceRefs = sources.map(s => s.id);
    remaining.captures = captures.map(c => c.id); remaining.messages = messages.map(m => m.id);
    remaining.messageRevisions = revisions.map(r => r.id); remaining.connections = connections.map(c => c.id);
  }
  const preview: DeletionPreview = { generation: repo.generation, dataSeq: meta.dataSeq, target,
    notes: notes.filter(n => noteIds.has(n.id)).map(n => ({ id: n.id, title: n.title, sources: sources.filter(s => s.knowledgeId === n.id).length })),
    conversations: conversations.filter(c => conversationIds.has(c.id)).map(c => ({ id: c.id, title: c.title })),
    counts: { notes: noteIds.size, histories: remaining.knowledgeRevisions.length, sourceCopies: remaining.sourceRefs.length, captures: remaining.captures.length, messages: remaining.messages.length, revisions: remaining.messageRevisions.length },
    retainedNotes: affected.length, detachedSources: detached.length, supersessionLinks: affected.filter(n => n.supersededById && noteIds.has(n.supersededById)).length };
  return { preview, remaining, detached, affected, noteIds, conversationIds, captureIds };
}
export async function previewDeletion(repo: KnowledgeRepository, target: DeleteTarget): Promise<DeletionPreview> {
  return repo.db.transaction('r', repo.db.tables, async () => (await plan(repo, target)).preview);
}
function detach(source: SourceRef, now: string): SourceRef {
  return { ...source, conversationId: null, captureId: null, revisionId: null, anchor: null, anchorStatus: 'unresolved', sourceRemovedAt: now };
}
export async function beginDeletion(repo: KnowledgeRepository, command: Confirm): Promise<SaveResult | undefined> {
  if (repo.generation !== command.generation) fail('GENERATION_CHANGED'); freshIntent(command.issuedAt);
  const payloadDigest = await digest(command), now = new Date().toISOString(), db = repo.db;
  return db.transaction('rw', db.tables, async () => {
    const current = await db.meta.get('library');
    if (current?.deletion) {
      if (current.deletion.payloadDigest !== payloadDigest) fail('LIBRARY_BUSY'); return undefined;
    }
    const meta = await repo.checkReady(true), receipt = await db.requestReceipts.get(command.requestId);
    if (receipt) {
      if (receipt.command !== command.type || receipt.payloadDigest !== payloadDigest) fail('REQUEST_ID_REUSED');
      return { ...receipt.result, deduplicated: true };
    }
    if (meta.dataSeq !== command.expectedDataSeq) fail('PREVIEW_CHANGED');
    const p = await plan(repo, command.target);
    for (const note of p.affected) await snapshotSources(repo, note.id);
    for (const row of p.detached) { const source = await db.sourceRefs.get(row.id); if (!source) fail('LIBRARY_CORRUPT'); await db.sourceRefs.put(detach(source, now)); }
    // Detach the declared retained excerpts in old provenance snapshots too.
    // The excerpt itself is preserved; deleted foreign references are not.
    await db.knowledgeRevisions.filter(h => !p.noteIds.has(h.knowledgeId) && (!!h.sources?.some(s => s.conversationId && p.conversationIds.has(s.conversationId)) || !!h.snapshot.supersededById && p.noteIds.has(h.snapshot.supersededById))).modify(h => {
      h.sources = h.sources?.map(s => s.conversationId && p.conversationIds.has(s.conversationId) ? detach(s, now) : s);
      if (h.snapshot.supersededById && p.noteIds.has(h.snapshot.supersededById)) h.snapshot = { ...h.snapshot, supersededById: null };
    });
    for (const row of p.affected) {
      const note = await db.knowledgeItems.get(row.id); if (!note) fail('LIBRARY_CORRUPT');
      const replaced = !!note.supersededById && p.noteIds.has(note.supersededById);
      await appendHistory(repo, { ...note, updatedAt: now, recordVersion: note.recordVersion + 1, currentVersion: note.currentVersion + 1,
        ...(replaced ? { supersededById: null, reviewState: 'needs_review' as const, reviewedAt: null } : {}) }, replaced ? 'replacement_removed' : 'source_removed');
    }
    await db.requestReceipts.filter(r => p.noteIds.has(r.result.knowledgeId)).modify({ invalidated: true });
    // A worker restart cannot resume a capture admitted before this operation.
    await db.captures.filter(c => c.captureStatus === 'in_progress').modify(c => { c.captureStatus = 'interrupted'; c.interruptionReason = 'library_deletion'; c.recordVersion++; c.updatedAt = now; });
    for (const conversation of await db.conversations.toArray()) {
      if (p.conversationIds.has(conversation.id)) continue;
      if (conversation.latestCaptureId && p.captureIds.has(conversation.latestCaptureId)) {
        const kept = (await db.captures.where('conversationId').equals(conversation.id).toArray()).filter(c => !p.captureIds.has(c.id)).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
        await db.conversations.put({ ...conversation, latestCaptureId: kept.at(-1)?.id ?? null, updatedAt: now, recordVersion: conversation.recordVersion + 1 });
      }
    }
    const result: SaveResult = { requestId: command.requestId, generation: repo.generation, knowledgeId: command.target.kind === 'note' ? command.target.noteId : command.requestId,
      recordVersion: 1, dataSeq: meta.dataSeq + 1, warnings: [], deduplicated: false, removed: true, retainedSources: p.detached.length };
    const deletion: DeletionJob = { command, payloadDigest, remaining: p.remaining, result };
    await db.meta.put({ ...meta, dataSeq: result.dataSeq, writeFence: { kind: 'delete', operationId: command.requestId }, deletion });
    return undefined;
  });
}
export async function resumeDeletion(repo: KnowledgeRepository): Promise<SaveResult | undefined> {
  const db = repo.db;
  for (;;) {
    const meta = await db.meta.get('library'), job = meta?.deletion;
    if (!job) return;
    if (meta.writeFence?.kind !== 'delete' || meta.writeFence.operationId !== job.command.requestId || job.command.generation !== repo.generation) fail('LIBRARY_CORRUPT');
    const table = deletionOrder.find(name => job.remaining[name].length);
    if (table) {
      await db.transaction('rw', [db.table(table), db.meta], async () => {
        const current = await db.meta.get('library');
        if (canonicalJson(current?.deletion) !== canonicalJson(job)) fail('LIBRARY_BUSY');
        await db.table(table).bulkDelete(job.remaining[table].slice(0, 256));
        job.remaining[table] = job.remaining[table].slice(256);
        await db.meta.put({ ...current!, deletion: job });
      });
    } else {
      await db.transaction('rw', [db.meta, db.requestReceipts], async () => {
        const current = await db.meta.get('library');
        if (current?.deletion?.command.requestId !== job.command.requestId) fail('LIBRARY_BUSY');
        await db.requestReceipts.put({ requestId: job.command.requestId, generation: repo.generation, command: 'DeleteLibraryData', payloadDigest: job.payloadDigest,
          issuedAt: job.command.issuedAt, createdAt: new Date().toISOString(), expiresAt: Date.parse(job.command.issuedAt) + RETRY_HORIZON_MS, result: job.result, invalidated: false });
        const { deletion: _finished, ...ready } = current;
        await db.meta.put({ ...ready, writeFence: null });
      });
      return job.result;
    }
  }
}
