import Dexie from 'dexie';
import { KnowledgeDatabase, databaseName } from './schema';
import { digest, fail, isId, SCHEMA_VERSION, RETRY_HORIZON_MS, parseLibraryCommand, type KnowledgeItem, type LibraryCommand, type LibraryMeta, type LibraryReply, type SaveManualNote } from '../shared/knowledge';
import { markdownPlainText } from '../shared/markdown';
import { appendHistory } from './management';

export const ACTIVE_LIBRARY_KEY = 'activeLibrary';
type Pointer = { generation: string; ready: boolean };
let opening: Promise<KnowledgeRepository> | undefined;
export async function closeRepository() {
  const pending = opening; opening = undefined;
  const repo = await pending?.catch(() => undefined); repo?.db.close();
}

// Called only by the service worker, after trusted-context settings restriction.
// Persist a resumable creation pointer BEFORE creating the database. A missing
// ready database is an error, never an invitation to silently reset the library.
export async function activeRepository(allowReset = false): Promise<KnowledgeRepository> {
  if (!allowReset && (await chrome.storage.local.get('resetOperation')).resetOperation) fail('LIBRARY_BUSY');
  if (!opening) opening = (async () => {
    let pointer = (await chrome.storage.local.get(ACTIVE_LIBRARY_KEY))[ACTIVE_LIBRARY_KEY] as Pointer | undefined;
    if (pointer === undefined) {
      pointer = { generation: crypto.randomUUID(), ready: false };
      await chrome.storage.local.set({ [ACTIVE_LIBRARY_KEY]: pointer });
    }
    if (!pointer || !isId(pointer.generation) || typeof pointer.ready !== 'boolean') fail('LIBRARY_CORRUPT');
    if (pointer.ready && !await Dexie.exists(databaseName(pointer.generation))) fail('STORAGE_MISSING');
    const repository = new KnowledgeRepository(pointer.generation);
    try {
      await repository.db.open();
      await repository.checkReady(false, true);
      if (!pointer.ready) await chrome.storage.local.set({ [ACTIVE_LIBRARY_KEY]: { ...pointer, ready: true } });
      return repository;
    } catch (error) { repository.db.close(); throw error; }
  })().catch(error => { opening = undefined; throw error; });
  const repository = await opening;
  const pointer = (await chrome.storage.local.get(ACTIVE_LIBRARY_KEY))[ACTIVE_LIBRARY_KEY] as Pointer | undefined;
  if (pointer?.generation !== repository.generation || !repository.db.isOpen()) {
    repository.db.close(); opening = undefined;
    return activeRepository(allowReset);
  }
  return repository;
}

export class KnowledgeRepository {
  readonly db: KnowledgeDatabase;
  constructor(readonly generation: string) { this.db = new KnowledgeDatabase(generation); }
  async checkReady(writing = false, allowDeletion = false): Promise<LibraryMeta> {
    // Dexie can retry open() without a version after native VersionError. Do
    // not mistake that compatibility fallback for an approved app migration.
    if (this.db.backendDB().version > SCHEMA_VERSION * 10) fail('SCHEMA_TOO_NEW');
    const meta = await this.db.meta.get('library');
    if (meta && meta.schemaVersion > SCHEMA_VERSION) fail('SCHEMA_TOO_NEW');
    if (!meta || meta.generation !== this.generation || meta.schemaVersion !== 1 || !Number.isSafeInteger(meta.dataSeq) || meta.dataSeq < 0) fail('LIBRARY_CORRUPT');
    if (meta.status !== 'ready' || (meta.writeFence && !(allowDeletion && meta.writeFence.kind === 'delete' && meta.deletion))) fail('LIBRARY_BUSY');
    if (writing && meta.dataSeq === Number.MAX_SAFE_INTEGER) fail('LIBRARY_CORRUPT');
    return meta;
  }
  async execute(value: LibraryCommand): Promise<LibraryReply> {
    const command = parseLibraryCommand(value);
    if (!command) fail('INVALID_COMMAND');
    if ('generation' in command && command.generation !== this.generation) fail('GENERATION_CHANGED');
    if (command.type === 'SaveManualNote') return { ok: true, result: await this.save(command) };
    return this.db.transaction('r', [this.db.meta, this.db.knowledgeItems, this.db.knowledgeRevisions, this.db.sourceRefs], async () => {
      const meta = await this.checkReady();
      if (command.type === 'ListNotes') {
        const eligible = this.db.knowledgeItems.orderBy('updatedAt').reverse().filter(note => note.reviewState !== 'superseded');
        const total = await eligible.clone().count();
        const notes = (await eligible.offset(command.offset).limit(100).toArray()).map(({ id, title, updatedAt, recordVersion, reviewState, type, plainText }) => ({ id, title, updatedAt, recordVersion, reviewState, type, preview: Array.from(plainText).slice(0, 180).join('') }));
        return { ok: true, library: { generation: this.generation, dataSeq: meta.dataSeq, total, notes } };
      }
      const note = await this.db.knowledgeItems.get(command.noteId);
      if (!note) fail('NOT_FOUND');
      if (command.type === 'GetNoteRevision') {
        const revision = await this.db.knowledgeRevisions.where('[knowledgeId+version]').equals([note.id, command.version]).first();
        if (!revision) fail('NOT_FOUND');
        return { ok: true, revision };
      }
      const rows = await this.db.knowledgeRevisions.where('[knowledgeId+version]').between([note.id, 1], [note.id, note.currentVersion], true, true).reverse().offset(command.historyOffset).limit(50).toArray();
      const sources = (await this.db.sourceRefs.where('knowledgeId').equals(note.id).toArray()).sort((a, b) => (a.fragmentOrder ?? 0) - (b.fragmentOrder ?? 0));
      return { ok: true, note, sources, dataSeq: meta.dataSeq, history: rows.map(({ version, changedAt, changeReason }) => ({ version, changedAt, changeReason })) };
    });
  }
  private async save(command: SaveManualNote) {
    const now = Date.now();
    const issued = Date.parse(command.issuedAt);
    if (issued > now + 5 * 60_000 || now - issued >= RETRY_HORIZON_MS) fail('INTENT_EXPIRED');
    // All CPU work and asynchronous hashing finish before opening a transaction.
    const [payloadDigest, contentHash] = await Promise.all([digest(command), digest({ kind: 'knowledge', fields: command.fields })]);
    const plainText = markdownPlainText(command.fields.bodyMarkdown);
    const id = command.noteId ?? crypto.randomUUID();
    const timestamp = new Date(now).toISOString();
    return this.db.transaction('rw', [this.db.meta, this.db.knowledgeItems, this.db.knowledgeRevisions, this.db.sourceRefs, this.db.requestReceipts], async () => {
      const meta = await this.checkReady(true);
      const receipt = await this.db.requestReceipts.get(command.requestId);
      if (receipt) {
        if (receipt.generation !== this.generation || receipt.command !== command.type || receipt.payloadDigest !== payloadDigest) fail('REQUEST_ID_REUSED');
        if (receipt.invalidated || !await this.db.knowledgeItems.get(receipt.result.knowledgeId) ||
            !await this.db.knowledgeRevisions.where('[knowledgeId+version]').equals([receipt.result.knowledgeId, receipt.result.recordVersion]).first()) fail('RESULT_REMOVED');
        return { ...receipt.result, deduplicated: true };
      }
      const previous = command.noteId ? await this.db.knowledgeItems.get(command.noteId) : undefined;
      if (command.noteId && !previous) fail('NOT_FOUND');
      if (previous && previous.recordVersion !== command.expectedRecordVersion) fail('VERSION_CONFLICT');
      if (previous && (!await this.db.knowledgeRevisions.where('[knowledgeId+version]').equals([previous.id, previous.currentVersion]).first() || previous.recordVersion !== previous.currentVersion)) fail('LIBRARY_CORRUPT');
      const version = (previous?.recordVersion ?? 0) + 1;
      if (!Number.isSafeInteger(version)) fail('LIBRARY_CORRUPT');
      const note: KnowledgeItem = {
        id, schemaVersion: 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, recordVersion: version,
        ...command.fields, plainText, contentHash, canonicalVersion: 1, currentVersion: version,
        reviewState: previous?.reviewState ?? 'saved', reviewedAt: previous?.reviewedAt ?? null,
        supersededById: previous?.supersededById ?? null, origin: previous?.origin ?? 'manual_note', sourceKind: previous?.sourceKind ?? 'manual',
        curationKey: previous?.curationKey ?? null, createdByRequestId: previous?.createdByRequestId ?? command.requestId,
        ...(previous?.excluded !== undefined ? { excluded: previous.excluded } : {}),
        ...(previous?.undoSelectionEligible !== undefined ? { undoSelectionEligible: previous.undoSelectionEligible } : {}),
      };
      await appendHistory(this, note, previous ? 'edited' : 'created');
      const result = { requestId: command.requestId, generation: this.generation, knowledgeId: id, recordVersion: version, dataSeq: meta.dataSeq + 1, warnings: [], deduplicated: false };
      await this.db.meta.put({ ...meta, dataSeq: result.dataSeq });
      // Expired intents are rejected before lookup, so pruning cannot resurrect them.
      await this.db.requestReceipts.where('expiresAt').belowOrEqual(now).delete();
      await this.db.requestReceipts.add({ requestId: command.requestId, generation: this.generation, command: command.type, payloadDigest, issuedAt: command.issuedAt, createdAt: timestamp, expiresAt: issued + RETRY_HORIZON_MS, result, invalidated: false });
      return result;
    }); // Dexie's transaction promise resolves only after native commit.
  }
}
