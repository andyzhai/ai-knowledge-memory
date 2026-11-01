import { checkBackupSize, parseBackupText, validateBackup, TRANSFER_CHARS, markdownFile, SECTIONS, type RestorePreview, type Backup } from '../shared/backup';
import { exactKeys, fail, isId } from '../shared/knowledge';
import { activeRepository } from '../storage/repository';
import { activateRestore, backupText, prepareRestore, recoverRestore, recoveryExport, snapshot } from '../storage/backup';
import { pauseViews, resumeViews } from './views';

export type BackupInfo = { generation: string; dataSeq: number; counts: Backup['counts']; notes: { id: string; title: string }[]; lastBackupAt: string | null; pendingRestore: boolean };
export type BackupReply = { ok: true; backup: { transferId?: string; chunks?: number; text?: string; preview?: RestorePreview; info?: BackupInfo; notice?: string } };
type Transfer = { id: string; owner: string; text: string; bytes: number; receivedBytes: number; lastUnit: number; next: number; touched: number };
let upload: Transfer | undefined, download: Transfer | undefined;
export function clearBackupTransfers() { upload = undefined; download = undefined; }
const types = ['BackupInfo', 'ExportBackup', 'ExportMarkdown', 'ReadBackupChunk', 'ReleaseBackupTransfer', 'BeginBackupUpload', 'UploadBackupChunk', 'PreviewRestore', 'ConfirmRestore', 'CancelRestore', 'ExportRecovery'];
export function isBackupRequest(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && types.includes((value as { type: string }).type); }
const ok = (backup: BackupReply['backup'] = {}): BackupReply => ({ ok: true, backup });
export async function handleBackup(c: Record<string, unknown>, owner: string, hooks: { cancelCaptures: () => Promise<void>; reconcile: () => Promise<void> }): Promise<BackupReply> {
  const valid = (fields = '') => { if (c.protocolVersion !== 1 || !exactKeys(c, ['protocolVersion', 'type', ...fields.split(' ').filter(Boolean)])) fail('INVALID_COMMAND'); };
  const transfer = (t: Transfer | undefined) => { if (!t || t.id !== c.transferId || t.owner !== owner || Date.now() - t.touched > 10 * 60_000) fail('TRANSFER_EXPIRED'); t.touched = Date.now(); return t; };
  const stageDownload = (text: string) => { checkBackupSize(new TextEncoder().encode(text).length); download = { id: crypto.randomUUID(), owner, text, bytes: 0, receivedBytes: 0, lastUnit: 0, next: 0, touched: Date.now() }; return ok({ transferId: download.id, chunks: Math.ceil(text.length / TRANSFER_CHARS) }); };
  if (c.type === 'BackupInfo') {
    valid(); const repo = await activeRepository();
    const info = await repo.db.transaction('r', repo.db.tables, async () => {
      const meta = await repo.checkReady(), counts = {} as Backup['counts']; for (const s of SECTIONS) counts[s] = await repo.db.table(s).count();
      return { generation: repo.generation, dataSeq: meta.dataSeq, counts, notes: (await repo.db.knowledgeItems.toArray()).map(n => ({ id: n.id, title: n.title })) };
    });
    const settings = await chrome.storage.local.get(['lastBackupAt', 'restoreOperation']);
    return ok({ info: { ...info, lastBackupAt: typeof settings.lastBackupAt === 'string' ? settings.lastBackupAt : null, pendingRestore: !!settings.restoreOperation } });
  }
  if (c.type === 'ExportRecovery') { valid(); return stageDownload(await recoveryExport()); }
  if (c.type === 'ExportBackup' || c.type === 'ExportMarkdown') {
    valid(c.type === 'ExportMarkdown' ? 'noteIds' : '');
    if (c.type === 'ExportMarkdown' && (!Array.isArray(c.noteIds) || c.noteIds.length === 0 || c.noteIds.length > 65535 || !c.noteIds.every(isId) || new Set(c.noteIds).size !== c.noteIds.length)) fail('INVALID_COMMAND');
    const b = await snapshot(await activeRepository());
    if (c.type === 'ExportMarkdown') {
      const ids = new Set(c.noteIds as string[]), selected = b.records.knowledgeItems.filter(n => ids.has(n.id));
      if (selected.length !== ids.size) fail('NOT_FOUND');
      return stageDownload(JSON.stringify(selected.map(n => markdownFile(n, b.records.sourceRefs.filter(s => s.knowledgeId === n.id)))));
    }
    return stageDownload(backupText(b));
  }
  if (c.type === 'ReadBackupChunk') {
    valid('transferId index'); const t = transfer(download);
    if (!Number.isSafeInteger(c.index) || (c.index as number) < 0 || (c.index as number) >= Math.ceil(t.text.length / TRANSFER_CHARS)) fail('INVALID_COMMAND');
    return ok({ text: t.text.slice((c.index as number) * TRANSFER_CHARS, ((c.index as number) + 1) * TRANSFER_CHARS) });
  }
  if (c.type === 'ReleaseBackupTransfer') { valid('transferId'); transfer(download); download = undefined; return ok(); }
  if (c.type === 'BeginBackupUpload') {
    valid('bytes'); checkBackupSize(c.bytes as number);
    upload = { id: crypto.randomUUID(), owner, text: '', bytes: c.bytes as number, receivedBytes: 0, lastUnit: 0, next: 0, touched: Date.now() }; return ok({ transferId: upload.id });
  }
  if (c.type === 'UploadBackupChunk') {
    valid('transferId index text'); const t = transfer(upload);
    if (c.index !== t.next || typeof c.text !== 'string' || c.text.length > TRANSFER_CHARS || t.text.length + c.text.length > t.bytes) fail('INVALID_COMMAND');
    let bytes = new TextEncoder().encode(c.text).length;
    // Reading the accumulated rope here would flatten the entire upload on
    // every chunk. Cache just its last UTF-16 unit to keep admission linear.
    const previous = t.lastUnit, first = c.text.charCodeAt(0);
    // Separate UTF-8 encodings replace split surrogate halves with 3+3 bytes;
    // the joined scalar occupies 4. Preserve exact chunk-boundary Unicode.
    if (previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
    if (t.receivedBytes + bytes > t.bytes) fail('BACKUP_INVALID');
    if (c.text.length) t.lastUnit = c.text.charCodeAt(c.text.length - 1);
    t.receivedBytes += bytes; t.text += c.text; t.next++; return ok();
  }
  if (c.type === 'PreviewRestore') {
    valid('transferId'); const t = transfer(upload); upload = undefined;
    if (new TextEncoder().encode(t.text).length !== t.bytes) fail('BACKUP_INVALID');
    const b = await validateBackup(parseBackupText(t.text)); return ok({ preview: await prepareRestore(b, t.bytes) });
  }
  if (c.type === 'CancelRestore') { valid(); const notice = await recoverRestore(); resumeViews(notice); return ok({ notice }); }
  if (c.type === 'ConfirmRestore') {
    valid('operationId mode'); if (!isId(c.operationId) || !['empty', 'replace'].includes(c.mode as string)) fail('INVALID_COMMAND');
    try {
      await pauseViews(c.operationId); await hooks.cancelCaptures(); await activateRestore(c.operationId, c.mode as 'empty' | 'replace');
      await hooks.reconcile(); resumeViews('Backup restored. Previous library removed. ChatGPT capture is off until you enable it again.');
      return ok();
    } catch (error) {
      // Before activation recovery abandons the target and releases the fence;
      // after activation it only finishes cleanup and never selects old data.
      const notice = await recoverRestore().catch(() => '');
      await hooks.reconcile(); resumeViews(notice || 'Restore or cleanup is unfinished. Open Backup and restore to inspect retained copies and resume maintenance.'); throw error;
    }
  }
  return fail('INVALID_COMMAND');
}
