import { canonicalJson, digest, fail, RETRY_HORIZON_MS } from '../shared/knowledge';
import { sourceHash, type Capture, type Message, type MessageRevision } from '../shared/archive';
import { LOADED_EXTRACTOR, parseCaptureCommand, type ArchiveRead, type ArchiveReply, type CaptureCommand, type CaptureProgress } from '../shared/loaded-capture';
import { conversationIdentity } from '../shared/protocol';
import type { SourceBinding } from '../shared/curation';
import { identifyCaller } from './curation';
import type { KnowledgeRepository } from './repository';

type Operation = Exclude<CaptureCommand, { type: 'BeginLoadedCapture' }>;
export async function prepareCapture(command: Operation, binding: SourceBinding) {
  if (!parseCaptureCommand(command)) fail('INVALID_COMMAND');
  if (command.route !== binding.route || command.nonce !== binding.nonce) fail('NAVIGATION_CHANGED');
  const [owner, payloadDigest, hashes, branchSignature, nonceDigest] = await Promise.all([
    identifyCaller(binding), digest(command),
    command.type === 'ArchiveCaptureBatch' ? Promise.all(command.messages.map(m => sourceHash('message', m.role, m.blocks))) : Promise.resolve([]),
    command.type === 'StartArchiveCapture' ? digest(command.plan.messageIds) : Promise.resolve(''),
    digest(command.nonce),
  ]);
  return { command, owner, payloadDigest, hashes, branchSignature, nonceDigest };
}
function fresh(issuedAt: string) {
  const age = Date.now() - Date.parse(issuedAt);
  if (age >= RETRY_HORIZON_MS || age < -300_000) fail('INTENT_EXPIRED');
}
export async function commitCapture(repo: KnowledgeRepository, prepared: Awaited<ReturnType<typeof prepareCapture>>): Promise<CaptureProgress> {
  const { command, owner, payloadDigest, hashes, branchSignature, nonceDigest } = prepared;
  if (command.generation !== repo.generation) fail('GENERATION_CHANGED');
  fresh(command.issuedAt);
  const db = repo.db, now = new Date().toISOString();
  const common = () => ({ id: crypto.randomUUID(), schemaVersion: 1 as const, createdAt: now, updatedAt: now, recordVersion: 1 });
  // The session row is the durable receipt: immutable start digest, accepted
  // batch hashes/membership and terminal status commit with canonical dataSeq.
  return db.transaction('rw', [db.meta, db.connections, db.conversations, db.captures, db.messages, db.messageRevisions], async () => {
    const meta = await repo.checkReady(true);
    let capture = await db.captures.get(command.sessionId), changed = false;
    if (capture) {
      if (canonicalJson(capture.owner ?? null) !== canonicalJson(owner)) fail('UNAUTHORIZED_CONTEXT');
      if (capture.providerEpoch !== command.providerEpoch || capture.issuedAt !== command.issuedAt) fail('REQUEST_ID_REUSED');
    }
    if (command.type === 'StartArchiveCapture') {
      if (capture) { if (capture.startDigest !== payloadDigest) fail('REQUEST_ID_REUSED'); }
      else {
        let connection = await db.connections.where('provider').equals('chatgpt').first();
        if (!connection) { connection = { ...common(), provider: 'chatgpt', namespace: crypto.randomUUID(), enabled: true, capturePolicy: 'manual', accountRef: null }; await db.connections.add(connection); }
        const identity = conversationIdentity(command.route)!;
        let conversation = await db.conversations.where('[connectionId+identityKey]').equals([connection.id, identity]).first();
        if (!conversation) {
          conversation = { ...common(), connectionId: connection.id, identityKey: identity, identityQuality: 'provider', canonicalUrl: command.route,
            title: command.plan.title, sourceKind: 'captured', providerConversationId: identity, latestCaptureId: null, lastCapturedAt: now,
            temporaryStatus: command.plan.temporaryStatus, createdByRequestId: command.sessionId };
          await db.conversations.add(conversation);
        }
        capture = { ...common(), id: command.sessionId, conversationId: conversation.id, revisionIds: [], membership: [], scope: 'loaded_conversation',
          historyCoverage: 'loaded_only', branchCoverage: 'visible_branch', warnings: command.plan.warnings, capturedAt: now,
          adapterVersion: LOADED_EXTRACTOR, captureStatus: 'in_progress', requestId: command.sessionId, createdByRequestId: command.sessionId, independentlyRetained: true,
          sessionId: command.sessionId, nextExpectedBatch: 0, acceptedBatches: [], declaredTotals: { batches: command.plan.batches, messages: command.plan.messages },
          navigationNonceDigest: nonceDigest, owner, providerEpoch: command.providerEpoch, startDigest: payloadDigest, issuedAt: command.issuedAt,
          branchObservation: { messageIds: command.plan.messageIds, signature: branchSignature } };
        changed = true;
      }
    } else {
      if (!capture) fail('NOT_FOUND');
      if (command.type === 'ArchiveCaptureBatch') {
        const accepted = capture.acceptedBatches.find(batch => batch.number === command.number);
        if (accepted) { if (accepted.hash !== payloadDigest) fail('BATCH_REUSED'); }
        else {
          if (capture.captureStatus !== 'in_progress') fail('CAPTURE_CLOSED');
          if (capture.nextExpectedBatch !== command.number || command.number >= capture.declaredTotals!.batches || capture.revisionIds.length + command.messages.length > capture.declaredTotals!.messages) fail('BATCH_OUT_OF_ORDER');
          const revisionIds: string[] = [];
          for (let index = 0; index < command.messages.length; index++) {
            const observed = command.messages[index]!, position = capture.revisionIds.length + index;
            if (capture.branchObservation!.messageIds[position] !== observed.sourceMessageId) fail('BATCH_MEMBERSHIP_CHANGED');
            let message: Message | undefined = observed.sourceMessageId ? await db.messages.where('[conversationId+sourceMessageId]').equals([capture.conversationId, observed.sourceMessageId]).first() : undefined;
            if (message && message.contentScope !== 'message') fail('LIBRARY_CORRUPT');
            if (!message) {
              message = { ...common(), conversationId: capture.conversationId, sourceMessageId: observed.sourceMessageId,
                identityQuality: observed.sourceMessageId ? 'provider' : 'unknown', contentScope: 'message', originMessageLocator: observed.sourceMessageId,
                latestObservedRevisionId: null, createdByRequestId: capture.requestId, independentlyRetained: true };
              await db.messages.add(message);
            }
            let revision = await db.messageRevisions.where('[messageId+contentHash]').equals([message.id, hashes[index]!]).first();
            if (!revision) {
              revision = { id: crypto.randomUUID(), schemaVersion: 1, messageId: message.id, role: observed.role, contentScope: 'message', blocks: observed.blocks,
                plainText: observed.blocks.map(block => block.text).filter(text => text.length > 0).join('\n\n'), contentHash: hashes[index]!, canonicalVersion: 1, observedAt: observed.observedAt,
                completion: observed.completion, extractorVersion: LOADED_EXTRACTOR, sourceCreatedAt: null, language: null, parentSourceMessageId: null };
              await db.messageRevisions.add(revision);
            }
            revisionIds.push(revision.id);
            capture.membership.push({ revisionId: revision.id, completion: observed.completion, observedAt: observed.observedAt, extractorVersion: LOADED_EXTRACTOR });
          }
          capture.revisionIds.push(...revisionIds);
          capture.acceptedBatches.push({ number: command.number, hash: payloadDigest, revisionIds });
          capture.nextExpectedBatch++; changed = true;
        }
      } else if (command.type === 'FinishArchiveCapture') {
        if (capture.captureStatus === 'interrupted') fail('CAPTURE_CLOSED');
        if (capture.nextExpectedBatch !== capture.declaredTotals?.batches || capture.revisionIds.length !== capture.declaredTotals.messages) fail('CAPTURE_INCOMPLETE');
        if (capture.captureStatus !== 'completed') { capture.captureStatus = 'completed'; changed = true; }
      } else if (command.type === 'InterruptArchiveCapture' && capture.captureStatus === 'in_progress') {
        capture.captureStatus = 'interrupted'; capture.interruptionReason = 'cancelled'; changed = true;
      }
    }
    if (!capture) fail('NOT_FOUND');
    if (changed) {
      capture.updatedAt = now; capture.recordVersion++;
      await db.captures.put(capture);
      // Search derives latest eligible revisions from memberships, never from
      // this pointer or from in-progress message observations.
      if (capture.captureStatus !== 'in_progress') await publishCapture(repo, capture, now);
      await db.meta.put({ ...meta, dataSeq: meta.dataSeq + 1 });
    }
    return { generation: repo.generation, dataSeq: meta.dataSeq + Number(changed), captureId: capture.id, status: capture.captureStatus,
      nextExpectedBatch: capture.nextExpectedBatch, committedMessages: capture.revisionIds.length };
  });
}
async function publishCapture(repo: KnowledgeRepository, capture: Capture, now: string) {
  const conversation = await repo.db.conversations.get(capture.conversationId);
  if (!conversation) fail('LIBRARY_CORRUPT');
  await repo.db.conversations.put({ ...conversation, latestCaptureId: capture.id, lastCapturedAt: now, updatedAt: now, recordVersion: conversation.recordVersion + 1 });
}
// Called after checking the owning document's live nonce. An idle worker restart
// alone is not an interruption. No timer/lease can silently expire a valid page.
export async function interruptOrphan(repo: KnowledgeRepository, id: string, reason: string) {
  await repo.db.transaction('rw', [repo.db.meta, repo.db.captures, repo.db.conversations], async () => {
    const meta = await repo.checkReady(true), capture = await repo.db.captures.get(id);
    if (!capture || capture.captureStatus !== 'in_progress') return;
    const now = new Date().toISOString();
    capture.captureStatus = 'interrupted'; capture.interruptionReason = reason; capture.updatedAt = now; capture.recordVersion++;
    await repo.db.captures.put(capture); await publishCapture(repo, capture, now); await repo.db.meta.put({ ...meta, dataSeq: meta.dataSeq + 1 });
  });
}
export async function readArchive(repo: KnowledgeRepository, command: ArchiveRead): Promise<ArchiveReply> {
  return repo.db.transaction('r', [repo.db.meta, repo.db.captures, repo.db.conversations, repo.db.messageRevisions], async () => {
    await repo.checkReady();
    if (command.type === 'ListArchiveCaptures') {
      const rows = await repo.db.captures.orderBy('capturedAt').reverse().filter(c => !command.conversationId || c.conversationId === command.conversationId).toArray();
      const captures = await Promise.all(rows.slice(command.offset, command.offset + 50).map(async c => ({ id: c.id, conversationId: c.conversationId, capturedAt: c.capturedAt,
        captureStatus: c.captureStatus, scope: c.scope, warnings: c.warnings, title: (await repo.db.conversations.get(c.conversationId))?.title ?? 'Conversation unavailable', messages: c.revisionIds.length })));
      return { ok: true, generation: repo.generation, captures, total: rows.length };
    }
    if (command.generation !== repo.generation) fail('GENERATION_CHANGED');
    const capture = await repo.db.captures.get(command.captureId);
    if (!capture) fail('NOT_FOUND');
    const conversation = await repo.db.conversations.get(capture.conversationId);
    if (!conversation) fail('LIBRARY_CORRUPT');
    const revisions = await repo.db.messageRevisions.bulkGet(capture.revisionIds.slice(command.offset, command.offset + 8));
    if (revisions.some(r => !r)) fail('LIBRARY_CORRUPT');
    return { ok: true, generation: repo.generation, detail: { capture, title: conversation.title, url: conversation.canonicalUrl, revisions: revisions as MessageRevision[], offset: command.offset } };
  });
}
