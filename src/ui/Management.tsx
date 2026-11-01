import { useEffect, useRef, useState } from 'react';
import { isId, type KnowledgeItem, type NoteSummary } from '../shared/knowledge';
import type { SourceRef } from '../shared/archive';
import type { DeleteCommand, DeleteTarget, DeletionPreview, ManageNote, ManagementReply } from '../shared/management';

async function request(command: ManageNote | DeleteCommand): Promise<ManagementReply> {
  return chrome.runtime.sendMessage(command);
}
function useNoteChoices(generation: string) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  useEffect(() => {
    let current = true;
    void (async () => {
      const rows: NoteSummary[] = [];
      for (let offset = 0; ; offset += 100) {
        const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ListNotes', offset });
        if (!current || !reply?.ok || !('library' in reply) || reply.library.generation !== generation) return;
        rows.push(...reply.library.notes); if (offset + 100 >= reply.library.total) break;
      }
      if (current) setNotes(rows);
    })().catch(() => { if (current) setNotes([]); });
    return () => { current = false; };
  }, [generation]);
  return notes;
}
export function DeleteControl({ generation, target, label = 'Preview permanent deletion' }: { generation: string; target: DeleteTarget; label?: string }) {
  const trigger = useRef<HTMLButtonElement>(null), previewHeading = useRef<HTMLHeadingElement>(null);
  const [preview, setPreview] = useState<DeletionPreview>(), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Extract<DeleteCommand, { type: 'DeleteLibraryData' }>>();
  useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);
  async function inspect() {
    setBusy(true); setNotice(''); setPreview(undefined); setPending(undefined);
    try {
      const reply = await request({ protocolVersion: 1, type: 'PreviewDeletion', generation, target });
      if (!reply.ok) setNotice(reply.message); else if ('preview' in reply) setPreview(reply.preview);
    } catch { setNotice('Could not read deletion dependencies. Nothing was removed.'); } finally { setBusy(false); }
  }
  async function remove() {
    if (!preview) return;
    const command = pending ?? { protocolVersion: 1, type: 'DeleteLibraryData', generation: preview.generation, target: preview.target,
      expectedDataSeq: preview.dataSeq, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString() } satisfies DeleteCommand;
    setPending(command); setBusy(true);
    try {
      const reply = await request(command);
      if (!reply.ok) { setNotice(`${reply.code}: ${reply.message}`); if (reply.code === 'PREVIEW_CHANGED') { setPreview(undefined); setPending(undefined); } }
      else setNotice('Deletion completed.');
    } catch { setNotice('Deletion is not confirmed. Retry this operation or use Resume interrupted deletion; do not assume it finished.'); }
    finally { setBusy(false); }
  }
  return <div className="deletion-control"><button ref={trigger} className="danger secondary" disabled={busy || !generation} onClick={() => void inspect()}>{label}</button>
    {preview && <section aria-label="Deletion preview"><h3 ref={previewHeading} tabIndex={-1}>Review permanent deletion</h3>
      <p>{preview.counts.notes} notes, {preview.counts.histories} note revisions, {preview.counts.sourceCopies} source excerpt copies, {preview.counts.captures} captures, {preview.counts.messages} messages and {preview.counts.revisions} message revisions will be removed.</p>
      <ul>{preview.notes.map(n => <li key={n.id}>{n.title || 'Untitled note'} · {n.sources} sources{n.sources > 1 ? ' (includes other sources)' : ''}</li>)}</ul>
      <ul>{preview.conversations.map(c => <li key={c.id}>{c.title || 'Untitled conversation'}</li>)}</ul>
      <p>{preview.detachedSources} excerpts will remain in Knowledge with their Archive source marked removed. {preview.supersessionLinks} replacement links will be cleared and the affected notes marked Needs review.</p>
      {preview.target.kind === 'all' && <p>All library generations, staging data, caches, receipts and settings will be removed. ChatGPT capture will be disabled until you enable it again. Packaged extension files remain installed.</p>}
      <p>Open editors and unsaved drafts in all extension views will close. Pending captures will stop. Independently retained or shared Archive sources remain when deleting a note.</p>
      <p>This also removes retained history in the stated scope. Editing a note body alone does not remove source or history copies. This cannot remove exported copies, clipboard history, OS backups, or guarantee forensic disk erasure.</p>
      <div className="actions"><button className="danger" disabled={busy} onClick={() => void remove()}>{pending ? 'Retry same deletion' : 'Confirm permanent deletion'}</button><button className="secondary" disabled={busy} onClick={() => { setPreview(undefined); setPending(undefined); trigger.current?.focus(); }}>Cancel deletion</button></div>
    </section>}<p role="status">{notice}</p></div>;
}
export function NoteManagement({ note, generation, disabled, changed, pendingChange }: { note: KnowledgeItem; generation: string; disabled: boolean; changed: (id: string) => Promise<void>; pendingChange?: (pending: boolean) => void }) {
  const [replacement, setReplacement] = useState(''), [sourceId, setSourceId] = useState('');
  const [sourceNote, setSourceNote] = useState(''), [sourceChoices, setSourceChoices] = useState<SourceRef[]>([]);
  const choices = useNoteChoices(generation).filter(n => n.id !== note.id);
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<ManageNote>();
  useEffect(() => { pendingChange?.(busy || !!pending); return () => pendingChange?.(false); }, [busy, pending, pendingChange]);
  useEffect(() => {
    let current = true;
    setSourceChoices([]); setSourceId('');
    if (sourceNote) void chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetNote', generation, noteId: sourceNote, historyOffset: 0 }).then(reply => {
      if (current && reply?.ok && 'sources' in reply) setSourceChoices(reply.sources);
    }).catch(() => { if (current) setNotice('Could not read the source note.'); });
    return () => { current = false; };
  }, [sourceNote, generation]);
  async function perform(fields: Omit<ManageNote, 'protocolVersion' | 'requestId' | 'issuedAt' | 'generation' | 'noteId' | 'expectedRecordVersion'> | Record<string, unknown>) {
    const command = pending ?? { protocolVersion: 1, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), generation, noteId: note.id, expectedRecordVersion: note.recordVersion, ...fields } as ManageNote;
    setPending(command); setBusy(true); setNotice('');
    try {
      const reply = await request(command);
      if (!reply.ok) { setNotice(`${reply.code}: ${reply.message}`); if (!reply.retryable) setPending(undefined); }
      else if ('result' in reply) { setPending(undefined); await changed(reply.result.knowledgeId); setNotice('Change saved in history.'); }
    } catch { setNotice('Change not confirmed. Retry the same action.'); }
    finally { setBusy(false); }
  }
  return <div aria-label="Note curation" className="note-curation">
    <p className="review-status"><span className="badge">{note.reviewState.replaceAll('_', ' ')}</span>{note.reviewedAt ? ` · reviewed ${new Date(note.reviewedAt).toLocaleString()}` : ''}{note.excluded ? ' · excluded from default recall' : ''}</p>
    {note.supersededById && <p>Replaced by {choices.find(n => n.id === note.supersededById)?.title || 'another saved note'}.</p>}
    <fieldset disabled={disabled || busy || !!pending}><div className="actions">
      <button disabled={note.reviewState === 'endorsed'} onClick={() => void perform({ type: 'ReviewNote', state: 'endorsed', supersededById: null })}>Endorse note</button>
      <button className="secondary" onClick={() => void perform({ type: 'ReviewNote', state: 'needs_review', supersededById: null })}>Needs review</button>
    </div></fieldset>
    <details className="context-section"><summary>Review and other actions</summary>
    <fieldset disabled={disabled || busy || !!pending}><div className="actions">
      <button onClick={() => void perform({ type: 'DuplicateNote' })}>Duplicate as new</button>
      <button onClick={() => void perform({ type: 'ExcludeNote', excluded: !note.excluded })}>{note.excluded ? 'Include in recall' : 'Exclude from recall'}</button>
    </div>
      <label>Newer note<select aria-label="Newer note" value={replacement} onChange={e => setReplacement(e.target.value)}><option value="">Choose a replacement</option>{choices.map(n => <option key={n.id} value={n.id}>{n.title || 'Untitled note'}</option>)}</select></label>
      <button disabled={!isId(replacement)} onClick={() => void perform({ type: 'ReviewNote', state: 'superseded', supersededById: replacement })}>Supersede with this note</button>
      <label>Source from another note<select aria-label="Source from another note" value={sourceNote} onChange={e => setSourceNote(e.target.value)}><option value="">Choose a source note</option>{choices.map(n => <option key={n.id} value={n.id}>{n.title || 'Untitled note'}</option>)}</select></label>
      <label>Excerpt to append<select aria-label="Excerpt to append" value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="">Choose an excerpt</option>{sourceChoices.map(s => <option key={s.id} value={s.id}>{s.sourceTitle}: {s.exactText.slice(0, 100)}</option>)}</select></label>
      <button disabled={!isId(sourceId)} onClick={() => void perform({ type: 'AddNoteSource', source: { kind: 'existing', sourceId } })}>Append existing source</button>
      <p>Choose a retained excerpt, or open an Archive message and append its exact quote. Earlier sources remain unchanged.</p>
    </fieldset>
    {!disabled && <DeleteControl generation={generation} target={{ kind: 'note', noteId: note.id }} label="Remove this note permanently" />}
    </details>
    {pending && <button disabled={busy} onClick={() => void perform(pending)}>Retry curation action</button>}<p role="status">{notice}</p>
  </div>;
}
export function ArchiveSourceAddition({ generation, captureId, revisionId, text }: { generation: string; captureId: string; revisionId: string; text: string }) {
  const [id, setId] = useState(''), [quote, setQuote] = useState(text), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ManageNote>();
  const choices = useNoteChoices(generation);
  async function add() {
    setBusy(true);
    try {
      let command = pending;
      if (!command) {
        const note = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetNote', generation, noteId: id, historyOffset: 0 });
        if (!note?.ok || !('note' in note)) { setNotice('The destination note could not be read.'); return; }
        command = { protocolVersion: 1, type: 'AddNoteSource', generation, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), noteId: id,
          expectedRecordVersion: note.note.recordVersion, source: { kind: 'archive', captureId, revisionId, quote } }; setPending(command);
      }
      const reply = await request(command);
      if (!reply.ok) { setNotice(`${reply.code}: ${reply.message}`); if (!reply.retryable) setPending(undefined); }
      else { setPending(undefined); setNotice('Source appended. The note body and earlier provenance are unchanged.'); }
    } catch { setNotice('Addition not confirmed. Retry the same addition.'); } finally { setBusy(false); }
  }
  return <details><summary>Add this source to Knowledge</summary><label>Destination note<select aria-label="Destination note" disabled={busy || !!pending} value={id} onChange={e => setId(e.target.value)}><option value="">Choose a note</option>{choices.map(n => <option key={n.id} value={n.id}>{n.title || 'Untitled note'}</option>)}</select></label>
    <label>Exact source quote<textarea disabled={busy || !!pending} value={quote} onChange={e => setQuote(e.target.value)} /></label>
    <button disabled={busy || !isId(id) || !quote.trim()} onClick={() => void add()}>{pending ? 'Retry source addition' : 'Append source quote'}</button><p role="status">{notice}</p></details>;
}
export function LibraryCleanup() {
  const [generation, setGeneration] = useState(''), [provider, setProvider] = useState(''), [through, setThrough] = useState('');
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setNotice('');
    try {
      const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ListNotes', offset: 0 });
      if (!reply?.ok || !('library' in reply)) throw new Error('unavailable');
      setGeneration(reply.library.generation);
    } catch { setNotice('Could not load cleanup controls. Try again. Nothing was removed.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Library cleanup"><h2>Manage retained data</h2>
    <p>No content expires automatically. Review dependencies before permanently removing data.</p>
    <details onToggle={event => { if (event.currentTarget.open && !generation && !busy) void load(); }}><summary>Cleanup and deletion</summary>
    {busy && <p role="status">Loading cleanup controls…</p>}
    {notice && <p role="alert">{notice} <button className="secondary" onClick={() => void load()}>Retry cleanup controls</button></p>}
    {generation && <><h3>Clean up Archive</h3><p>Remove older captures while keeping retained Knowledge excerpts.</p><label>Cleanup provider<select value={provider} onChange={e => setProvider(e.target.value)}><option value="">All providers</option><option value="chatgpt">ChatGPT</option><option value="gemini">Gemini</option><option value="perplexity">Perplexity</option></select></label>
      <label>Last captured on or before<input type="date" value={through} onChange={e => setThrough(e.target.value)} /></label>
      {through && <DeleteControl key={`${provider}:${through}`} generation={generation} target={{ kind: 'archive_filter', provider: provider as 'chatgpt' || null, through }} label="Preview Archive cleanup, keep Knowledge" />}
      <div className="danger-zone"><h3>Delete all data</h3><p>Remove the entire local library and disable capture. Download a backup first.</p><DeleteControl generation={generation} target={{ kind: 'all' }} label="Preview Delete all data" /></div></>}
    </details>
  </section>;
}
