import { useEffect, useRef, useState } from 'react';
import { checkBackupSize, markdownZip, TRANSFER_CHARS, type RestorePreview } from '../shared/backup';
import type { BackupInfo, BackupReply } from '../background/backup-service';

async function request(type: string, fields: Record<string, unknown> = {}) {
  const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type, ...fields }) as BackupReply | { ok: false; code: string; message: string };
  if (!reply?.ok) throw new Error(reply?.message || 'The worker did not confirm this operation. Retry; do not assume it completed.');
  return reply.backup;
}
async function downloadText(type: string, fields: Record<string, unknown> = {}) {
  const transfer = await request(type, fields); const chunks: string[] = [];
  try { for (let index = 0; index < transfer.chunks!; index++) chunks.push((await request('ReadBackupChunk', { transferId: transfer.transferId, index })).text!); }
  finally { await request('ReleaseBackupTransfer', { transferId: transfer.transferId }).catch(() => undefined); }
  return chunks.join('');
}
function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export function BackupControls({ active = true }: { active?: boolean }) {
  const [info, setInfo] = useState<BackupInfo>(), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [preview, setPreview] = useState<RestorePreview>();
  const [mode, setMode] = useState<'empty' | 'replace'>('empty'), [confirmed, setConfirmed] = useState(false);
  const previewHeading = useRef<HTMLHeadingElement>(null), restoreInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);
  async function refresh() { setInfo((await request('BackupInfo')).info); }
  useEffect(() => { if (active) void refresh().catch(e => { setFailed(true); setNotice(String(e.message)); }); }, [active]);
  async function work(action: () => Promise<void>) { setBusy(true); setNotice(''); setFailed(false); try { await action(); } catch (e) { setFailed(true); setNotice(e instanceof Error ? e.message : 'Operation failed. Nothing was confirmed.'); } finally { setBusy(false); } }
  async function exportBackup() {
    const text = await downloadText('ExportBackup');
    save(new Blob([text], { type: 'application/json' }), `knowledge-backup-${new Date().toISOString().slice(0, 10)}.json`);
    await chrome.storage.local.set({ lastBackupAt: new Date().toISOString() }); await refresh();
    setNotice('Backup download started. Check your browser downloads and keep a verified copy outside this profile.');
  }
  async function inspect(file: File) {
    setPreview(undefined); setConfirmed(false); checkBackupSize(file.size);
    const text = await file.text(), transfer = await request('BeginBackupUpload', { bytes: file.size });
    for (let start = 0, index = 0; start < text.length; start += TRANSFER_CHARS, index++) await request('UploadBackupChunk', { transferId: transfer.transferId, index, text: text.slice(start, start + TRANSFER_CHARS) });
    const next = (await request('PreviewRestore', { transferId: transfer.transferId })).preview!;
    setPreview(next); setMode(Object.values(next.currentCounts).some(n => n > 0) ? 'replace' : 'empty'); await refresh();
  }
  return <section aria-labelledby="backup-title"><h2 id="backup-title">Backup and restore</h2>
    <p>Save your library, sources and history in a portable JSON file. Keep a copy outside this Chrome profile.</p>
      <div className="actions"><button disabled={busy} onClick={() => void work(exportBackup)}>Download backup</button></div>
      {info && <p className="caption">{info.lastBackupAt ? `Last download started: ${new Date(info.lastBackupAt).toLocaleString()}. Verify the file was saved.` : 'No backup downloaded from this profile yet.'}</p>}
      <details onToggle={event => { if (event.currentTarget.open) void refresh().catch(e => { setFailed(true); setNotice(String(e.message)); }); }}><summary>Export selected Knowledge as Markdown</summary>
        <p>Markdown is a one-way export. Use a JSON backup to restore history and the full library.</p>
        <fieldset disabled={busy}><legend>Notes to export, including excluded and superseded notes</legend>
          {info?.notes.map(n => <label key={n.id}><input type="checkbox" checked={selected.includes(n.id)} onChange={e => setSelected(e.target.checked ? [...selected, n.id] : selected.filter(id => id !== n.id))} />{n.title || 'Untitled note'}</label>)}
        </fieldset>
        <button disabled={busy || !selected.length} onClick={() => void work(async () => {
          const files = JSON.parse(await downloadText('ExportMarkdown', { noteIds: selected })) as { filename: string; body: string }[];
          if (files.length === 1) save(new Blob([files[0]!.body], { type: 'text/markdown;charset=utf-8' }), files[0]!.filename);
          else save(new Blob([markdownZip(files)], { type: 'application/zip' }), 'knowledge-markdown.zip');
          setNotice('Markdown download started. Source caveats are included; revision history requires the JSON backup.');
        })}>Download selected Markdown{selected.length > 1 ? ' ZIP' : ''}</button>
      </details>
      <details className="context-section"><summary>Restore a JSON backup</summary>
      <p>Choose a backup to validate and review before replacing this library. Nothing changes until you confirm. Backups are not merged.</p>
      <label>Choose canonical backup<input ref={restoreInput} type="file" accept=".json,application/json" disabled={busy || !!info?.pendingRestore} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void work(() => inspect(file)); }} /></label>
      {preview && <section aria-label="Restore preview"><h3 ref={previewHeading} tabIndex={-1}>Review library replacement</h3>
        <p>Current: {preview.currentCounts.knowledgeItems} notes and {preview.currentCounts.captures} captures. Backup: {preview.counts.knowledgeItems} notes, {preview.counts.knowledgeRevisions} history records, {preview.counts.sourceRefs} sources and {preview.counts.captures} captures.</p>
        <details><summary>Storage requirements</summary><p>Backup size: {preview.bytes.toLocaleString()} bytes. Estimated additional staging space: {preview.estimatedAdditionalBytes.toLocaleString()} bytes. {preview.availableBytes === null ? 'Available space is unknown.' : `Browser-reported available space: ${preview.availableBytes.toLocaleString()} bytes.`} Estimates cannot guarantee free disk space.</p></details>
        <label>Restore mode<select value={mode} onChange={e => setMode(e.target.value as 'empty' | 'replace')} disabled={busy}><option value="empty">Restore into empty library</option><option value="replace">Replace library</option></select></label>
        <p>Download the current library above before replacing it. Confirmation closes unsaved editors in every view, clears search, removes the old library after activation and disables capture. Provider permissions and temporary conversation allowances are never imported.</p>
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I reviewed the replacement and saved any current data I need.</label>
        <button className="danger" disabled={busy || !confirmed} onClick={() => void work(async () => { await request('ConfirmRestore', { operationId: preview.operationId, mode }); })}>Confirm restore</button>
      </section>}
      </details>
      {(preview || info?.pendingRestore) && <p className="feedback">A staging or previous library copy is retained until this operation is completed or cancelled. <button className="secondary" disabled={busy} onClick={() => void work(async () => { const reply = await request('CancelRestore'); setPreview(undefined); await refresh(); setNotice(reply.notice ?? 'Pending restore cleared.'); requestAnimationFrame(() => { if (restoreInput.current?.checkVisibility()) restoreInput.current.focus(); else restoreInput.current?.closest('details')?.querySelector('summary')?.focus(); }); })}>Cancel preview / finish cleanup</button></p>}
      <details><summary>Backup details and recovery</summary>
        <p>Backups and Markdown contain unencrypted text, source excerpts and retained history.</p>
        {info && <p>{info.counts.knowledgeItems} notes, {info.counts.knowledgeRevisions} note revisions, {info.counts.sourceRefs} sources, {info.counts.captures} captures and {info.counts.messageRevisions} message revisions.</p>}
        <button className="secondary" disabled={busy} onClick={() => void work(async () => { await refresh(); setNotice('Backup scope refreshed.'); })}>Refresh backup scope</button>
        <p>The uncompressed rejection ceiling is 200 MiB, not a demonstrated capacity guarantee. Validation reads the file into memory and staging needs space alongside the current library. Validation or staging failure keeps the current library.</p>
        <h3>Read-only storage recovery</h3><p>If a schema upgrade cannot open this library, export a recovery file for a compatible extension or recovery tool. This preserves raw records, is not a canonical restore backup, and never resets storage.</p>
        <button disabled={busy} onClick={() => void work(async () => { const text = await downloadText('ExportRecovery'); save(new Blob([text], { type: 'application/json' }), 'knowledge-read-only-recovery.json'); setNotice('Read-only recovery download started. Keep the original profile intact.'); })}>Download read-only recovery file</button>
      </details>
    <p role={failed ? 'alert' : 'status'} className={busy || notice ? 'feedback' : undefined}>{busy ? 'Working locally; wait for confirmation…' : notice}</p>
  </section>;
}
