import Dexie from 'dexie';
import { activeRepository, closeRepository, KnowledgeRepository, ACTIVE_LIBRARY_KEY } from './repository';
import { KnowledgeDatabase, databaseName } from './schema';
import { canonicalJson, fail, isId, type LibraryMeta } from '../shared/knowledge';
import { makeBackup, validateBackup, checkBackupSize, SECTIONS, type Backup, type Records, type RestorePreview } from '../shared/backup';
import type { Capture } from '../shared/archive';

export const RESTORE_KEY = 'restoreOperation';
export type RestoreOperation = { operationId: string; oldGeneration: string; newGeneration: string; phase: 'staging' | 'prepared' | 'fenced' | 'activated'; expectedDataSeq: number; counts: Backup['counts']; bytes: number };
async function operation(): Promise<RestoreOperation | undefined> { return (await chrome.storage.local.get(RESTORE_KEY))[RESTORE_KEY] as RestoreOperation | undefined; }
export function portableCapture(c: Capture) {
  const { owner: _owner, providerEpoch: _epoch, startDigest: _digest, issuedAt: _issued, navigationNonceDigest: _nonce, acceptedBatches: _batches, nextExpectedBatch: _next, ...portable } = c;
  return portable;
}
// All tables and S are read in ONE native read-only transaction. Hashing and
// serialization happen after it commits. No canonical data is read by the UI.
export async function snapshot(repo: KnowledgeRepository): Promise<Backup> {
  const pending = await operation();
  // A completed, unconfirmed preview intentionally permits exporting the old
  // library before replacement. Incomplete maintenance does not.
  if (pending && pending.phase !== 'prepared') fail('LIBRARY_BUSY');
  const captured = await repo.db.transaction('r', repo.db.tables, async () => {
    const meta = await repo.checkReady();
    if ((await repo.db.captures.filter(c => c.captureStatus === 'in_progress').count()) > 0) fail('CAPTURE_ACTIVE');
    const records = {} as Records; let bytes = 0;
    for (const section of SECTIONS) {
      const rows: unknown[] = [];
      await repo.db.table(section).each(row => {
        const record = section === 'captures' ? portableCapture(row as Capture) : row;
        bytes += new TextEncoder().encode(JSON.stringify(record)).length + 1; checkBackupSize(bytes); rows.push(record);
      });
      Object.assign(records, { [section]: rows });
    }
    return { records, meta };
  });
  return makeBackup(captured.records, captured.meta.libraryId, captured.meta.dataSeq);
}
async function counts(repo: KnowledgeRepository) {
  const result = {} as Backup['counts']; for (const s of SECTIONS) result[s] = await repo.db.table(s).count(); return result;
}
// A blocked deletion leaves the journal intact, makes the retained copy visible,
// and returns immediately instead of silently hanging behind another DB handle.
const pendingDeletes = new Set<string>();
export async function deleteGeneration(generation: string) {
  if (!isId(generation)) fail('LIBRARY_CORRUPT');
  if (pendingDeletes.has(generation)) fail('CLEANUP_BLOCKED');
  await new Promise<void>((resolve, reject) => {
    pendingDeletes.add(generation);
    const request = indexedDB.deleteDatabase(databaseName(generation));
    request.onsuccess = () => { pendingDeletes.delete(generation); resolve(); }; request.onerror = () => { pendingDeletes.delete(generation); reject(request.error); };
    request.onblocked = () => reject(new Error('CLEANUP_BLOCKED'));
  }).catch(error => { if (error instanceof Error && error.message === 'CLEANUP_BLOCKED') fail('CLEANUP_BLOCKED'); throw error; });
}
export async function prepareRestore(backup: Backup, bytes: number): Promise<RestorePreview> {
  if (await operation()) fail('RESTORE_PENDING');
  const repo = await activeRepository();
  const current = await repo.db.transaction('r', repo.db.tables, async () => {
    const meta = await repo.checkReady();
    if (await repo.db.captures.filter(c => c.captureStatus === 'in_progress').count()) fail('CAPTURE_ACTIVE');
    return { meta, counts: await counts(repo) };
  });
  const estimate = await navigator.storage.estimate();
  const availableBytes = estimate.quota === undefined ? null : Math.max(0, estimate.quota - (estimate.usage ?? 0));
  const estimatedAdditionalBytes = bytes * 3; // Conservative estimate, not a disk guarantee.
  if (availableBytes !== null && availableBytes < estimatedAdditionalBytes) fail('STORAGE_FULL');
  const op: RestoreOperation = { operationId: crypto.randomUUID(), oldGeneration: repo.generation, newGeneration: crypto.randomUUID(), phase: 'staging', expectedDataSeq: current.meta.dataSeq, counts: backup.counts, bytes };
  await chrome.storage.local.set({ [RESTORE_KEY]: op });
  const db = new KnowledgeDatabase(op.newGeneration);
  try {
    await db.open();
    await db.meta.put({ id: 'library', schemaVersion: 1, libraryId: backup.libraryId, generation: op.newGeneration, dataSeq: backup.dataSeq, status: 'staging', writeFence: { operationId: op.operationId, kind: 'restore' } });
    for (const section of SECTIONS) {
      for (let start = 0; start < backup.records[section].length; start += 128) {
        const rows = backup.records[section].slice(start, start + 128).map(row => {
          if (section === 'connections') return { ...row, enabled: false };
          if (section === 'captures') return { ...row, nextExpectedBatch: 0, acceptedBatches: [], navigationNonceDigest: null };
          return row;
        });
        await db.transaction('rw', db.table(section), () => db.table(section).bulkAdd(rows));
      }
    }
    // Verify the stored graph, not just the input. Restore never trusts a phase
    // marker as evidence that the writes actually reached disk.
    const records = {} as Records;
    for (const section of SECTIONS) Object.assign(records, { [section]: (await db.table(section).toArray()).map(row => section === 'captures' ? portableCapture(row) : row) });
    await validateBackup(await makeBackup(records, backup.libraryId, backup.dataSeq));
    await db.meta.update('library', { status: 'ready', writeFence: null });
    op.phase = 'prepared'; await chrome.storage.local.set({ [RESTORE_KEY]: op });
    return { operationId: op.operationId, generation: repo.generation, dataSeq: current.meta.dataSeq, currentCounts: current.counts, counts: backup.counts, bytes, estimatedAdditionalBytes, availableBytes };
  } catch (error) {
    db.close(); await recoverRestore().catch(() => undefined); throw error;
  } finally { db.close(); }
}
export async function activateRestore(operationId: string, mode: 'empty' | 'replace') {
  const op = await operation(); if (!op || op.operationId !== operationId || op.phase !== 'prepared') fail('RESTORE_EXPIRED');
  const repo = await activeRepository(); if (repo.generation !== op.oldGeneration) fail('GENERATION_CHANGED');
  const target = new KnowledgeRepository(op.newGeneration);
  if (!await Dexie.exists(databaseName(op.newGeneration))) fail('STORAGE_MISSING');
  try { await target.db.open(); await target.checkReady(); } finally { target.db.close(); }
  await repo.db.transaction('rw', repo.db.tables, async () => {
    const meta = await repo.checkReady(); if (meta.dataSeq !== op.expectedDataSeq) fail('PREVIEW_CHANGED');
    if (mode === 'empty' && Object.values(await counts(repo)).some(n => n > 0)) fail('LIBRARY_NOT_EMPTY');
    if (await repo.db.captures.filter(c => c.captureStatus === 'in_progress').count()) fail('CAPTURE_ACTIVE');
    await repo.db.meta.put({ ...meta, writeFence: { operationId, kind: 'restore' }, restore: { operationId, targetGeneration: op.newGeneration, phase: 'fenced' } });
  });
  op.phase = 'fenced'; await chrome.storage.local.set({ [RESTORE_KEY]: op });
  await closeRepository();
  // This pointer is the activation commit point. Recovery must never roll it
  // back after new-generation writes could have been accepted.
  await chrome.storage.local.set({ [ACTIVE_LIBRARY_KEY]: { generation: op.newGeneration, ready: true }, chatgptProbeEnabled: false, chatgptProviderEpoch: crypto.randomUUID() });
  op.phase = 'activated'; await chrome.storage.local.set({ [RESTORE_KEY]: op });
  await chrome.storage.session.clear();
  await recoverRestore();
}
export async function recoverRestore(): Promise<string> {
  const op = await operation(); if (!op) return '';
  if (!isId(op.operationId) || !isId(op.oldGeneration) || !isId(op.newGeneration) || op.oldGeneration === op.newGeneration) fail('LIBRARY_CORRUPT');
  const pointer = (await chrome.storage.local.get(ACTIVE_LIBRARY_KEY))[ACTIVE_LIBRARY_KEY] as { generation: string; ready: boolean } | undefined;
  await closeRepository();
  if (pointer?.generation === op.newGeneration && pointer.ready) {
    const target = new KnowledgeRepository(op.newGeneration);
    if (!await Dexie.exists(databaseName(op.newGeneration))) fail('STORAGE_MISSING');
    try { await target.db.open(); await target.checkReady(false, true); } finally { target.db.close(); }
    await deleteGeneration(op.oldGeneration);
    for (const name of await caches.keys()) await caches.delete(name);
    await chrome.storage.session.clear();
    await chrome.storage.local.remove(RESTORE_KEY);
    return 'Backup restored. The previous library and derived caches were removed. ChatGPT capture is off until you enable it again.';
  }
  if (pointer?.generation !== op.oldGeneration || !pointer.ready) fail('LIBRARY_CORRUPT');
  // Settle abandoned staging before releasing its old-generation fence.
  await deleteGeneration(op.newGeneration);
  const old = new KnowledgeDatabase(op.oldGeneration);
  if (!await Dexie.exists(databaseName(op.oldGeneration))) fail('STORAGE_MISSING');
  try {
    await old.open(); await old.transaction('rw', old.meta, async () => {
      const meta = await old.meta.get('library'); if (!meta) fail('LIBRARY_CORRUPT');
      if (meta.writeFence?.operationId === op.operationId && meta.writeFence.kind === 'restore') {
        const { restore: _restore, ...rest } = meta; await old.meta.put({ ...rest, writeFence: null });
      }
    });
  } finally { old.close(); }
  await chrome.storage.local.remove(RESTORE_KEY);
  return 'Interrupted restore was cancelled before activation. Your original library is unchanged.';
}
// Read-only salvage also works for a newer native schema. It never upgrades,
// rewrites, or claims that unknown records are a supported restore format.
export async function recoveryExport(): Promise<string> {
  const { activeLibrary, restoreOperation, resetOperation } = await chrome.storage.local.get(['activeLibrary', RESTORE_KEY, 'resetOperation']) as { activeLibrary?: { generation: string; ready: boolean }; restoreOperation?: unknown; resetOperation?: unknown };
  if (restoreOperation || resetOperation) fail('LIBRARY_BUSY');
  if (!isId(activeLibrary?.generation) || !activeLibrary.ready || !await Dexie.exists(databaseName(activeLibrary.generation))) fail('STORAGE_MISSING');
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName(activeLibrary.generation)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    return await new Promise<string>((resolve, reject) => {
      const names = Array.from(db.objectStoreNames).filter(n => n !== 'requestReceipts'), tx = db.transaction(names, 'readonly');
      const records: Record<string, unknown[]> = {}; let bytes = 0;
      for (const name of names) { records[name] = []; const request = tx.objectStore(name).openCursor(); request.onsuccess = () => {
        const cursor = request.result; if (!cursor) return;
        try { bytes += new TextEncoder().encode(JSON.stringify(cursor.value)).length; checkBackupSize(bytes); records[name]!.push(cursor.value); cursor.continue(); } catch { tx.abort(); }
      }; }
      tx.oncomplete = () => { const meta = records.meta?.find(x => (x as LibraryMeta).id === 'library') as LibraryMeta | undefined;
        if (meta?.writeFence || meta?.deletion) { try { fail('LIBRARY_BUSY'); } catch (error) { reject(error); } return; }
        resolve(JSON.stringify({ format: 'akm-read-only-recovery', nativeVersion: db.version, exportedAt: new Date().toISOString(), records })); };
      tx.onabort = () => reject(tx.error ?? new Error('BACKUP_TOO_LARGE')); tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export function backupText(backup: Backup) { const text = canonicalJson(backup); checkBackupSize(new TextEncoder().encode(text).length); return text; }
