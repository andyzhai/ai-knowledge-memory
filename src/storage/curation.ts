import { canonicalJson, digest, fail, RETRY_HORIZON_MS, type KnowledgeItem, type RequestReceipt, type SaveResult } from '../shared/knowledge';
import { sourceHash, validAnchor, type Block, type Capture, type Conversation, type Message, type MessageRevision, type SourceRef } from '../shared/archive';
import { parseCurationCommand, type CurateSelection, type SelectionAction, type SourceBinding, type CurationOwner } from '../shared/curation';
import type { KnowledgeRepository } from './repository';
import { conversationIdentity } from '../shared/protocol';

function fresh(issuedAt: string): void {
  const age = Date.now() - Date.parse(issuedAt);
  if (age >= RETRY_HORIZON_MS || age < -300_000) fail('INTENT_EXPIRED');
}
export async function identifyCaller(binding: SourceBinding): Promise<CurationOwner> {
  return { tabId: binding.tabId, documentId: binding.documentId, nonce: binding.nonce, routeDigest: await digest(binding.route) };
}
function sameCaller(receipt: RequestReceipt, caller?: CurationOwner): void {
  if (caller && canonicalJson(receipt.caller ?? null) !== canonicalJson(caller)) fail('UNAUTHORIZED_CONTEXT');
}
export async function selectionReceipt(repo: KnowledgeRepository, generation: string, requestId: string, caller?: CurationOwner): Promise<RequestReceipt> {
  if (generation !== repo.generation) fail('GENERATION_CHANGED');
  await repo.checkReady();
  const receipt = await repo.db.requestReceipts.get(requestId);
  if (!receipt || receipt.command !== 'CurateSelection') fail('NOT_FOUND');
  sameCaller(receipt, caller);
  fresh(receipt.issuedAt);
  return receipt;
}

export async function prepareSelection(command: CurateSelection, caller: SourceBinding) {
  if (!parseCurationCommand(command)) fail('INVALID_COMMAND');
  fresh(command.issuedAt);
  if (caller.route !== command.snapshot.sourceUrl || caller.nonce !== command.nonce) fail('NAVIGATION_CHANGED');
  const snapshot = command.snapshot;
  const blocks = snapshot.fragments.map(fragment => [{ kind: fragment.kind, text: fragment.exactText, ...(fragment.kind === 'code' ? { language: null } : {}) }] as Block[]);
  const [payloadDigest, contentHash, nonceDigest, curationKey, hashes, owner] = await Promise.all([
    digest({ command, caller }), digest({ kind: 'selection', selectedText: snapshot.selectedText }), digest(command.nonce),
    snapshot.fragments.every(fragment => fragment.sourceMessageId !== null) ? digest({ action: 'keep', provider: 'chatgpt', route: snapshot.sourceUrl,
      fragments: snapshot.fragments.map(({ sourceMessageId, exactText, startCodePoint, endCodePoint, role }) => ({ sourceMessageId, exactText, startCodePoint, endCodePoint, role })) }) : Promise.resolve(null),
    Promise.all(snapshot.fragments.map((fragment, index) => sourceHash('excerpt', fragment.role, blocks[index]!))),
    identifyCaller(caller),
  ]);
  return { command, caller: owner, blocks, hashes, payloadDigest, contentHash, nonceDigest, curationKey };
}

export async function curate(repo: KnowledgeRepository, prepared: Awaited<ReturnType<typeof prepareSelection>>): Promise<SaveResult> {
  const { command, caller, blocks, hashes, payloadDigest, contentHash, nonceDigest, curationKey } = prepared;
  if (command.generation !== repo.generation) fail('GENERATION_CHANGED');
  fresh(command.issuedAt);
  const snapshot = command.snapshot;
  const db = repo.db;
  const now = new Date().toISOString();
  const common = () => ({ id: crypto.randomUUID(), schemaVersion: 1 as const, createdAt: now, updatedAt: now, recordVersion: 1 });
  return db.transaction('rw', db.tables, async () => {
    const meta = await repo.checkReady(true);
    const prior = await db.requestReceipts.get(command.requestId);
    if (prior) {
      sameCaller(prior, caller);
      if (prior.command !== command.type || prior.payloadDigest !== payloadDigest) fail('REQUEST_ID_REUSED');
      if (prior.invalidated || !await db.knowledgeItems.get(prior.result.knowledgeId)) fail('RESULT_REMOVED');
      return { ...prior.result, deduplicated: true };
    }
    const existing = curationKey ? await db.knowledgeItems.where('curationKey').equals(curationKey).first() : undefined;
    let result: SaveResult;
    if (existing) {
      result = { requestId: command.requestId, generation: repo.generation, knowledgeId: existing.id, recordVersion: existing.recordVersion, dataSeq: meta.dataSeq, warnings: snapshot.warnings, deduplicated: true, created: false };
    } else {
      let connection = await db.connections.where('provider').equals('chatgpt').first();
      if (!connection) {
        connection = { ...common(), provider: 'chatgpt', namespace: crypto.randomUUID(), enabled: true, capturePolicy: 'manual', accountRef: null };
        await db.connections.add(connection);
      }
      const identity = conversationIdentity(snapshot.sourceUrl)!;
      let conversation = await db.conversations.where('[connectionId+identityKey]').equals([connection.id, identity]).first();
      if (!conversation) {
        conversation = { ...common(), connectionId: connection.id, identityKey: identity, identityQuality: 'provider', canonicalUrl: snapshot.sourceUrl,
          title: 'ChatGPT conversation', sourceKind: 'captured', providerConversationId: identity, latestCaptureId: null, lastCapturedAt: now, temporaryStatus: snapshot.temporaryStatus, createdByRequestId: command.requestId };
        await db.conversations.add(conversation);
      }
      const captureId = crypto.randomUUID();
      const note: KnowledgeItem = { ...common(), title: 'ChatGPT selection', bodyMarkdown: snapshot.selectedText, plainText: snapshot.selectedText,
        type: 'personal_note', tags: [], personalExplanation: '', applicableVersion: '', reviewAfter: null,
        contentHash, canonicalVersion: 1, currentVersion: 1, reviewState: 'saved', reviewedAt: null, supersededById: null,
        origin: 'manual_selection', sourceKind: 'captured', curationKey, createdByRequestId: command.requestId };
      const revisionIds: string[] = [];
      for (const [index, fragment] of snapshot.fragments.entries()) {
        let message: Message = { ...common(), conversationId: conversation.id, sourceMessageId: null, identityQuality: 'unknown', contentScope: 'excerpt',
          originMessageLocator: fragment.sourceMessageId, latestObservedRevisionId: null, createdByRequestId: command.requestId, independentlyRetained: false };
        let revision: MessageRevision = { id: crypto.randomUUID(), schemaVersion: 1, messageId: message.id, role: fragment.role, contentScope: 'excerpt',
          blocks: blocks[index]!, plainText: fragment.exactText, contentHash: hashes[index]!, canonicalVersion: 1,
          observedAt: now, completion: 'unknown', extractorVersion: snapshot.extractorVersion, sourceCreatedAt: null, language: null, parentSourceMessageId: null };
        let anchor = { quote: fragment.exactText, start: 0, end: Array.from(fragment.exactText).length, extractorVersion: snapshot.extractorVersion };
        let reused = false;
        const full = fragment.sourceMessageId ? await db.messages.where('[conversationId+sourceMessageId]').equals([conversation.id, fragment.sourceMessageId]).first() : undefined;
        if (full?.contentScope === 'message') {
          const knownRevisions = await db.messageRevisions.where('messageId').equals(full.id).toArray();
          const ids = new Set(knownRevisions.map(r => r.id));
          const observations = (await db.captures.where('conversationId').equals(conversation.id).filter(c => c.captureStatus !== 'in_progress').toArray())
            .flatMap(c => c.membership.filter(member => ids.has(member.revisionId)).map(member => ({ ...member, order: `${member.observedAt}:${c.capturedAt}:${c.id}` })))
            .sort((a, b) => b.order.localeCompare(a.order));
          const latest = knownRevisions.find(r => r.id === observations[0]?.revisionId);
          const offset = latest?.plainText.indexOf(fragment.exactText) ?? -1;
          // Known locator, role and a unique exact canonical quote establish
          // correspondence. Ambiguity keeps the original excerpt-only fallback.
          if (latest && latest.role === fragment.role && offset >= 0 && latest.plainText.indexOf(fragment.exactText, offset + 1) < 0) {
            message = full; revision = latest; reused = true;
            const start = Array.from(latest.plainText.slice(0, offset)).length;
            anchor = { ...anchor, start, end: start + Array.from(fragment.exactText).length, extractorVersion: latest.extractorVersion };
          }
        }
        if (!validAnchor(revision.plainText, anchor)) fail('LIBRARY_CORRUPT');
        if (!reused) { message.latestObservedRevisionId = revision.id; await db.messages.add(message); await db.messageRevisions.add(revision); }
        revisionIds.push(revision.id);
        const source: SourceRef = { id: crypto.randomUUID(), schemaVersion: 1, knowledgeId: note.id, sourceKind: 'captured', exactText: fragment.exactText,
          sourceProvider: 'chatgpt', sourceTitle: conversation.title, capturedAt: now, sourceUrl: snapshot.sourceUrl,
          conversationId: conversation.id, captureId, revisionId: revision.id, anchorStatus: 'resolved', anchor,
          originalPageAnchor: fragment.sourceMessageId ? { quote: fragment.exactText, start: fragment.startCodePoint, end: fragment.endCodePoint, extractorVersion: snapshot.extractorVersion,
            locator: fragment.sourceMessageId, prefix: '', suffix: '' } : null,
          fidelityWarnings: snapshot.warnings, sourceContentHash: revision.contentHash, sourceRemovedAt: null,
          fragmentOrder: index, sourceRole: fragment.role, contentScope: revision.contentScope, blockKind: fragment.kind, temporaryStatus: snapshot.temporaryStatus };
        await db.sourceRefs.add(source);
      }
      const capture: Capture = { ...common(), id: captureId, conversationId: conversation.id, revisionIds,
        membership: revisionIds.map(revisionId => ({ revisionId, completion: 'unknown', observedAt: now, extractorVersion: snapshot.extractorVersion })),
        scope: 'selection', historyCoverage: 'unknown', branchCoverage: 'unknown', warnings: snapshot.warnings,
        capturedAt: now, adapterVersion: snapshot.extractorVersion, captureStatus: 'completed', requestId: command.requestId,
        createdByRequestId: command.requestId, independentlyRetained: false, sessionId: command.requestId, nextExpectedBatch: 1,
        acceptedBatches: [{ number: 0, hash: payloadDigest, revisionIds }], declaredTotals: { batches: 1, messages: revisionIds.length }, navigationNonceDigest: nonceDigest };
      await db.captures.add(capture);
      await db.conversations.put({ ...conversation, latestCaptureId: capture.id, lastCapturedAt: now, updatedAt: now, recordVersion: conversation.recordVersion + 1 });
      await db.knowledgeItems.add(note);
      await db.knowledgeRevisions.add({ id: crypto.randomUUID(), schemaVersion: 1, knowledgeId: note.id, version: 1, changedAt: now, changeReason: 'created', snapshot: note });
      result = { requestId: command.requestId, generation: repo.generation, knowledgeId: note.id, recordVersion: 1, dataSeq: meta.dataSeq + 1, warnings: snapshot.warnings, deduplicated: false, created: true };
      await db.meta.put({ ...meta, dataSeq: result.dataSeq });
    }
    await db.requestReceipts.where('expiresAt').belowOrEqual(Date.now()).delete();
    await db.requestReceipts.add({ requestId: command.requestId, generation: repo.generation, command: command.type, payloadDigest, issuedAt: command.issuedAt,
      createdAt: now, expiresAt: Date.parse(command.issuedAt) + RETRY_HORIZON_MS, result, invalidated: false, caller });
    return result;
  });
}

export async function actOnSelection(repo: KnowledgeRepository, command: SelectionAction, caller?: CurationOwner): Promise<SaveResult> {
  if (!parseCurationCommand(command)) fail('INVALID_COMMAND');
  if (repo.generation !== command.generation) fail('GENERATION_CHANGED');
  fresh(command.issuedAt);
  const payloadDigest = await digest(command);
  const db = repo.db;
  return db.transaction('rw', db.tables, async () => {
    const meta = await repo.checkReady(true);
    const original = await selectionReceipt(repo, command.generation, command.savedRequestId, caller);
    const prior = await db.requestReceipts.get(command.requestId);
    if (prior) {
      sameCaller(prior, caller);
      if (prior.command !== command.type || prior.payloadDigest !== payloadDigest) fail('REQUEST_ID_REUSED');
      if (prior.invalidated) fail('RESULT_REMOVED');
      return { ...prior.result, deduplicated: true };
    }
    if (original.invalidated) fail('RESULT_REMOVED');
    const note = await db.knowledgeItems.get(original.result.knowledgeId);
    if (!note) fail('NOT_FOUND');
    if (note.recordVersion !== command.expectedRecordVersion) fail('VERSION_CONFLICT');
    const now = new Date().toISOString();
    let retainedSources = 0;
    if (command.type === 'EndorseSelection') {
      if (note.reviewState !== 'saved' && note.reviewState !== 'needs_review') fail('VERSION_CONFLICT');
      const updated: KnowledgeItem = { ...note, reviewState: 'endorsed', reviewedAt: now, updatedAt: now, recordVersion: note.recordVersion + 1, currentVersion: note.currentVersion + 1 };
      await db.knowledgeItems.put(updated);
      await db.knowledgeRevisions.add({ id: crypto.randomUUID(), schemaVersion: 1, knowledgeId: note.id, version: updated.currentVersion, changedAt: now, changeReason: 'endorsed', snapshot: updated });
    } else {
      if (!original.result.created || note.createdByRequestId !== command.savedRequestId) fail('UNDO_NOT_CREATED');
      if (note.recordVersion !== 1 || note.reviewState !== 'saved' || await db.knowledgeItems.filter(item => item.supersededById === note.id).count()) fail('UNDO_CHANGED');
      const sources = await db.sourceRefs.where('knowledgeId').equals(note.id).toArray();
      await db.sourceRefs.where('knowledgeId').equals(note.id).delete();
      await db.knowledgeRevisions.where('knowledgeId').equals(note.id).delete();
      await db.knowledgeItems.delete(note.id);
      const conversations = new Set<string>();
      for (const captureId of new Set(sources.map(source => source.captureId).filter((id): id is string => !!id))) {
        const capture = await db.captures.get(captureId);
        if (!capture || capture.scope !== 'selection' || capture.recordVersion !== 1 || capture.createdByRequestId !== command.savedRequestId || capture.independentlyRetained || await db.sourceRefs.where('captureId').equals(captureId).count()) { retainedSources++; continue; }
        let independentlyRetained = false;
        for (const revisionId of capture.revisionIds) {
          const revision = await db.messageRevisions.get(revisionId);
          if (revision && (await db.messages.get(revision.messageId))?.independentlyRetained) independentlyRetained = true;
        }
        if (independentlyRetained) { retainedSources++; continue; }
        await db.captures.delete(captureId); conversations.add(capture.conversationId);
        for (const revisionId of capture.revisionIds) {
          const revision = await db.messageRevisions.get(revisionId);
          const message = revision ? await db.messages.get(revision.messageId) : undefined;
          if (!revision || !message || message.recordVersion !== 1 || message.createdByRequestId !== command.savedRequestId || message.independentlyRetained ||
              await db.messageRevisions.where('messageId').equals(message.id).count() !== 1 ||
              await db.sourceRefs.where('revisionId').equals(revisionId).count() || await db.captures.filter(item => item.revisionIds.includes(revisionId)).count()) { retainedSources++; continue; }
          await db.messageRevisions.delete(revisionId);
          if (!await db.messageRevisions.where('messageId').equals(message.id).count()) await db.messages.delete(message.id);
        }
      }
      for (const id of conversations) {
        const remaining = await db.captures.where('conversationId').equals(id).sortBy('capturedAt');
        const conversation = await db.conversations.get(id);
        if (conversation?.createdByRequestId === command.savedRequestId && !remaining.length && !await db.messages.where('conversationId').equals(id).count() && !await db.sourceRefs.where('conversationId').equals(id).count()) await db.conversations.delete(id);
        else if (conversation) await db.conversations.put({ ...conversation, latestCaptureId: remaining.at(-1)?.id ?? null, recordVersion: conversation.recordVersion + 1, updatedAt: now } satisfies Conversation);
      }
      await db.requestReceipts.filter(receipt => receipt.result.knowledgeId === note.id).modify({ invalidated: true });
    }
    const result: SaveResult = { requestId: command.requestId, generation: repo.generation, knowledgeId: note.id, recordVersion: command.type === 'EndorseSelection' ? note.recordVersion + 1 : note.recordVersion,
      dataSeq: meta.dataSeq + 1, warnings: [], deduplicated: false, removed: command.type === 'UndoSelection', retainedSources };
    await db.meta.put({ ...meta, dataSeq: result.dataSeq });
    await db.requestReceipts.add({ requestId: command.requestId, generation: repo.generation, command: command.type, payloadDigest, issuedAt: command.issuedAt, createdAt: now,
      expiresAt: Date.parse(command.issuedAt) + RETRY_HORIZON_MS, result, invalidated: false, ...(caller ? { caller } : {}) });
    return result;
  });
}
