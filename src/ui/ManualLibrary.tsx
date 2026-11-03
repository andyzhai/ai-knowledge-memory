import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { libraryError, type HistoryEntry, type KnowledgeItem, type LibraryCommand, type LibraryReply, type NoteFields, type NoteSummary, type SaveManualNote } from '../shared/knowledge';
import { SafeMarkdown } from './SafeMarkdown';
import { NoteEditor } from './NoteEditor';
import { NoteMetadata, NoteSources, NoteHistory } from './NoteDetails';
import type { SourceRef } from '../shared/archive';
import type { SelectionAction } from '../shared/curation';
import { NoteManagement } from './Management';
import { KnowledgeSearch } from './KnowledgeSearch';
import type { NavigationGuard } from './navigation';

const empty: NoteFields = { title: '', bodyMarkdown: '', type: 'personal_note', tags: [], personalExplanation: '', applicableVersion: '', reviewAfter: null };
async function send(command: LibraryCommand | SelectionAction): Promise<LibraryReply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      chrome.runtime.sendMessage(command) as Promise<LibraryReply>,
      new Promise<LibraryReply>(resolve => { timer = setTimeout(() => resolve(libraryError(new Error('timeout'))), 10_000); }),
    ]);
    return reply && typeof reply.ok === 'boolean' ? reply : libraryError(new Error('missing reply'));
  } catch { return libraryError(new Error('transport')); }
  finally { clearTimeout(timer); }
}
function fieldsOf(note: KnowledgeItem): NoteFields {
  const { title, bodyMarkdown, type, tags, personalExplanation, applicableVersion, reviewAfter } = note;
  return { title, bodyMarkdown, type, tags, personalExplanation, applicableVersion, reviewAfter };
}
export function ManualLibrary({ noteId, selectNote, active, navigationGuard }: { noteId?: string; selectNote: (id?: string, replace?: boolean) => void; active: boolean; navigationGuard: RefObject<NavigationGuard | undefined> }) {
  const [generation, setGeneration] = useState('');
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [note, setNote] = useState<KnowledgeItem>();
  const [draft, setDraft] = useState<NoteFields>(empty);
  const [tags, setTags] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(!noteId);
  const [preview, setPreview] = useState(false);
  const [showDetail, setShowDetail] = useState(!!noteId);
  const [switchRequest, setSwitchRequest] = useState<{ proceed: () => void }>();
  const switchDialog = useRef<HTMLDialogElement>(null);
  const browser = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [openingNote, setOpeningNote] = useState(!!noteId);
  const [notice, setNotice] = useState('Loading local library…');
  const [failure, setFailure] = useState<Extract<LibraryReply, { ok: false }>>();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historical, setHistorical] = useState<KnowledgeItem>();
  const [historicalSources, setHistoricalSources] = useState<SourceRef[]>([]);
  const [placeholder, setPlaceholder] = useState('[API_KEY]');
  const title = useRef<HTMLHeadingElement>(null);
  const [conflict, setConflict] = useState<KnowledgeItem>();
  const [conflictSources, setConflictSources] = useState<SourceRef[]>([]);
  const [conflictHistory, setConflictHistory] = useState<HistoryEntry[]>([]);
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [sourceChecks, setSourceChecks] = useState<Record<string, string>>({});
  const [selectionAction, setSelectionAction] = useState<SelectionAction>();
  const [managementPending, setManagementPending] = useState(false);
  const openedQuery = useRef<string | undefined | null>(null);
  const requestedNote = useRef(noteId); requestedNote.current = noteId;
  const selectNoteRef = useRef(selectNote); selectNoteRef.current = selectNote;
  const pending = useRef<SaveManualNote | undefined>(undefined);
  const refreshId = useRef(0);
  const offsetRef = useRef(offset); offsetRef.current = offset;
  const openSerial = useRef(0);

  async function refresh(pageOffset = offset) {
    const id = ++refreshId.current;
    const reply = await send({ protocolVersion: 1, type: 'ListNotes', offset: pageOffset });
    if (id !== refreshId.current) return;
    if (reply.ok && 'library' in reply) {
      setGeneration(reply.library.generation); setNotes(reply.library.notes); setTotal(reply.library.total); setOffset(pageOffset);
      setNotice('Local library ready.');
    } else if (!reply.ok) { setFailure(reply); setNotice(''); }
  }
  useEffect(() => {
    void refresh(0);
    const focus = () => { void refresh(offsetRef.current); };
    const changed = (message: { type?: string }, sender: chrome.runtime.MessageSender) => {
      if (sender.id === chrome.runtime.id && message.type === 'KnowledgeChanged') void refresh(offsetRef.current);
    };
    window.addEventListener('focus', focus);
    chrome.runtime.onMessage.addListener(changed);
    return () => { ++refreshId.current; ++openSerial.current; window.removeEventListener('focus', focus); chrome.runtime.onMessage.removeListener(changed); };
  }, []);
  const canSwitch = !dirty && !pending.current && !selectionAction && !busy && !managementPending;
  navigationGuard.current = (next, proceed) => {
    if (next.destination !== 'knowledge' || next.noteId === openedQuery.current || (!dirty && !pending.current && !selectionAction && !managementPending)) return false;
    setSwitchRequest({ proceed }); return true;
  };
  useEffect(() => {
    if (switchRequest) switchDialog.current?.showModal();
  }, [switchRequest]);
  function cancelSwitch() {
    // Close while the native dialog is still connected so Chrome restores focus.
    switchDialog.current?.close(); setSwitchRequest(undefined);
  }
  useEffect(() => {
    if (!generation || !canSwitch || noteId === openedQuery.current) return;
    openedQuery.current = noteId;
    if (noteId) { setShowDetail(true); void open(noteId); }
    else { adopt(); setHistory([]); setHistoryOffset(0); setOpeningNote(false); }
  }, [generation, noteId, canSwitch]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (dirty || pending.current || selectionAction || managementPending) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, selectionAction, managementPending]);
  useEffect(() => {
    if (note?.id && title.current?.checkVisibility()) title.current.focus();
  }, [note?.id]);
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice('Copied exact visible text.'); }
    catch { setNotice('Clipboard unavailable. Select and copy the visible text manually.'); }
  }
  function adopt(current?: KnowledgeItem) {
    setSourceChecks({});
    setNote(current); setDraft(current ? fieldsOf(current) : empty); setTags(current?.tags.join(', ') ?? '');
    setDirty(false); setFailure(undefined); setConflict(undefined); setHistorical(undefined); pending.current = undefined; setSelectionAction(undefined);
    setEditing(!current); setPreview(false);
    if (!current) setSources([]);
  }
  async function open(id: string, at = 0) {
    const token = ++openSerial.current;
    setOpeningNote(true);
    setNote(undefined); setSources([]); setHistory([]); setHistorical(undefined); setFailure(undefined);
    setBusy(true);
    try {
      const reply = await send({ protocolVersion: 1, type: 'GetNote', generation, noteId: id, historyOffset: at });
      if (token !== openSerial.current) return;
      if (reply.ok && 'note' in reply) { adopt(reply.note); setSources(reply.sources); setHistory(reply.history); setHistoryOffset(at); setNotice(''); }
      else if (!reply.ok) setFailure(reply);
    } finally { if (token === openSerial.current) { setBusy(false); setOpeningNote(false); } }
  }
  async function historyPage(at: number) {
    if (!note) return;
    setBusy(true);
    try {
      const reply = await send({ protocolVersion: 1, type: 'GetNote', generation, noteId: note.id, historyOffset: at });
      if (reply.ok && 'note' in reply) { setHistory(reply.history); setHistoryOffset(at); setHistorical(undefined); }
      else if (!reply.ok) setFailure(reply);
    } finally { setBusy(false); }
  }
  async function selectionOperation(type: SelectionAction['type']) {
    if (!note) return;
    const request = selectionAction ?? { protocolVersion: 1, type, generation, savedRequestId: note.createdByRequestId,
      expectedRecordVersion: note.recordVersion, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString() } satisfies SelectionAction;
    setSelectionAction(request); setBusy(true); setFailure(undefined);
    try {
      const reply = await send(request);
      if (reply.ok && 'result' in reply) {
        const notice = reply.result.removed ? `Undone. ${(reply.result.retainedSources ?? 0) > 0 ? 'Shared or independently retained source data remains.' : 'The new note and its exclusive excerpts were removed.'}` : 'Endorsed. Your approval is recorded in saved history.';
        if (reply.result.removed) { adopt(); setHistory([]); openedQuery.current = undefined; selectNoteRef.current(undefined, true); }
        else await open(note.id);
        setSelectionAction(undefined); await refresh(0);
        setNotice(notice);
      } else if (!reply.ok) { setFailure(reply); if (!reply.retryable) setSelectionAction(undefined); }
    } finally { setBusy(false); }
  }
  function change<K extends keyof NoteFields>(key: K, value: NoteFields[K]) {
    setDraft(current => ({ ...current, [key]: value })); setDirty(true); setFailure(undefined);
  }
  async function save(): Promise<boolean> {
    setBusy(true); setFailure(undefined); setNotice('Saving…');
    const command = pending.current ?? {
      protocolVersion: 1, type: 'SaveManualNote', requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), generation,
      noteId: note?.id ?? null, expectedRecordVersion: note?.recordVersion ?? null,
      fields: { ...draft, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) },
    } satisfies SaveManualNote;
    pending.current = command;
    try {
      let reply = await send(command);
      // Transport/storage retries use the same exact intent, never a new UUID.
      for (let attempt = 0; !reply.ok && reply.retryable && attempt < 2; attempt++) reply = await send(command);
      if (reply.ok && 'result' in reply) {
        const saved = await send({ protocolVersion: 1, type: 'GetNote', generation: command.generation, noteId: reply.result.knowledgeId, historyOffset: 0 });
        if (saved.ok && 'note' in saved) {
          adopt(saved.note); setSources(saved.sources); setHistory(saved.history); setHistoryOffset(0); setShowDetail(true);
          if (requestedNote.current === openedQuery.current) {
            openedQuery.current = saved.note.id; selectNoteRef.current(saved.note.id, true);
          }
          await refresh(0);
          setNotice(`Saved to Knowledge · version ${reply.result.recordVersion}${reply.result.deduplicated ? ' · retry confirmed' : ''}.`);
          return true;
        } else {
          // Keep the receipt intent until hydration succeeds; otherwise a create
          // whose acknowledgement arrived could be accidentally submitted anew.
          setFailure(!saved.ok ? saved : libraryError(new Error('read')));
          setNotice('Save committed, but the saved note could not be reopened. Retry the same save to reopen it.');
        }
      } else if (!reply.ok) {
        setFailure(reply); setNotice('');
        if (!reply.retryable) pending.current = undefined;
        if (reply.code === 'VERSION_CONFLICT' && note) {
          const latest = await send({ protocolVersion: 1, type: 'GetNote', generation, noteId: note.id, historyOffset: 0 });
          if (latest.ok && 'note' in latest) { setConflict(latest.note); setConflictSources(latest.sources); setConflictHistory(latest.history); }
        }
      }
    } finally { setBusy(false); }
    return false;
  }
  async function checkOriginalSource(source: SourceRef) {
    setSourceChecks(checks => ({ ...checks, [source.id]: 'Checking original source…' }));
    try {
      const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'VerifyOriginalSource', generation, sourceId: source.id });
      const messages: Record<string, string> = { verified: 'Original source verified now; exact quote selected on the source page.', ambiguous: 'Original source ambiguous; no location was chosen.', missing: 'Original message is not loaded. Its local excerpt remains available.', changed: 'Source changed: the same message identity no longer contains the saved quote.', unavailable: 'Original source unavailable. Open one matching ChatGPT tab with access enabled, or use the local excerpt.' };
      setSourceChecks(checks => ({ ...checks, [source.id]: messages[reply?.location] ?? 'Original source could not be checked. Local excerpt remains available.' }));
    } catch { setSourceChecks(checks => ({ ...checks, [source.id]: 'Original source unavailable. Local excerpt remains available.' })); }
  }
  async function openRevision(version: number) {
    setBusy(true);
    try {
      const reply = await send({ protocolVersion: 1, type: 'GetNoteRevision', generation, noteId: note!.id, version });
      if (reply.ok && 'revision' in reply) { setHistorical(reply.revision.snapshot); setHistoricalSources(reply.revision.sources ?? []); } else if (!reply.ok) setFailure(reply);
    } finally { setBusy(false); }
  }
  const captured = note?.origin === 'manual_selection';
  const locked = busy || openingNote || !generation || !!pending.current;
  return <section aria-label="Manual knowledge library" className="manual-library" data-has-note={showDetail}>
    <div className="note-browser" ref={browser}>
    <div className="browser-heading"><h2>Your Knowledge</h2><button disabled={busy || !!pending.current || !!selectionAction || managementPending} onClick={() => {
      const start = () => { openedQuery.current = undefined; selectNote(); adopt(); setHistory([]); setHistoryOffset(0); setShowDetail(true); requestAnimationFrame(() => document.getElementById('note-title')?.focus()); };
      if (dirty) setSwitchRequest({ proceed: start }); else start();
    }}>New note</button></div>
    <KnowledgeSearch active={active} allowArchive={false} selectedId={note?.id} openNote={id => { if (id === noteId) setShowDetail(true); else selectNote(id); }} recent={<div aria-label="Recent notes">
    {total === 0 && generation && <p>No notes yet. Choose New note to keep your first idea.</p>}
    <ul className="note-list">{notes.map(item => <li key={item.id}><button className="search-open list-item" aria-label={item.title || 'Untitled note'} aria-current={note?.id === item.id ? 'true' : undefined} onClick={() => {
      if (item.id === noteId) setShowDetail(true); else selectNote(item.id);
    }}><h3>{item.title || 'Untitled note'}</h3>
    <span className="list-preview">{item.preview}</span>
    <span className="caption">{item.reviewState.replaceAll('_', ' ')} · {new Date(item.updatedAt).toLocaleDateString()}</span></button></li>)}</ul>
    {total > 100 && <div className="actions"><button disabled={busy || offset === 0} onClick={() => void refresh(Math.max(0, offset - 100))}>Previous notes</button><span>{offset + 1}–{Math.min(offset + 100, total)} of {total}</span><button disabled={busy || offset + 100 >= total} onClick={() => void refresh(offset + 100)}>Next notes</button></div>}
    </div>} />
    <button className="secondary refresh-list" disabled={busy} onClick={() => void refresh()}>Refresh library</button>
    </div>
    <div className="note-detail">
    <button className="secondary back-to-list" onClick={() => { setShowDetail(false); requestAnimationFrame(() => browser.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus()); }}>Back to notes</button>
    {openingNote ? <p role="status">Opening note…</p> : noteId && !note ? <div role="alert"><h2>Note unavailable</h2>
      <p>{failure?.message ?? 'This saved note could not be opened.'}</p><button onClick={() => void open(noteId)}>Retry opening note</button>
    </div> : <>
    <div className="editor-heading"><h2 ref={title} tabIndex={-1}>{editing ? (note ? 'Edit note' : 'Write a manual note') : note?.title || 'Untitled note'}</h2>
      {note && !editing && <button onClick={() => setEditing(true)}>Edit</button>}</div>
    {note && !editing && <>
      <p className="caption">{note.type.replaceAll('_', ' ')} · {note.reviewState.replaceAll('_', ' ')} · Updated {new Date(note.updatedAt).toLocaleDateString()} · v{note.recordVersion}</p>
      <div className="note-reading"><SafeMarkdown body={note.bodyMarkdown} /></div>
      {(note.tags.length > 0 || note.applicableVersion || note.reviewAfter || note.personalExplanation) && <details><summary>Note metadata</summary><NoteMetadata note={note} /></details>}
      <details><summary>Copy note</summary><div className="actions"><button className="secondary" onClick={() => void copy(note.plainText)}>Copy saved text</button>
      <button className="secondary" onClick={() => void copy(note.bodyMarkdown)}>Copy saved Markdown</button></div></details>
    </>}
    {editing && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      {note && <p className="caption">{captured ? 'Kept from ChatGPT' : 'Written by you'} · {note.reviewState} · version {note.recordVersion}</p>}
      <NoteEditor draft={draft} tags={tags} placeholder={placeholder} locked={locked} preview={preview} change={change}
        onTagsChange={value => { setTags(value); setDirty(true); }} onPreviewChange={setPreview}
        onPlaceholderChange={setPlaceholder} onNotice={setNotice} />
      <div className="actions"><button type="submit" disabled={busy || !generation || !draft.bodyMarkdown.trim() || !!conflict}>{pending.current ? 'Retry same save' : 'Save note'}</button>
        {!pending.current && <button className="secondary" type="button" disabled={busy} onClick={() => { adopt(note); if (!note) setShowDetail(false); }}>Cancel</button>}</div>
    </form>}
    {captured && note.undoSelectionEligible !== false && note.recordVersion === 1 && <div aria-label="Selection actions">
      <div className="actions">
        {selectionAction ? <button disabled={busy} onClick={() => void selectionOperation(selectionAction.type)}>Retry selection action</button> : <>
          <button className="secondary" disabled={!canSwitch || note.recordVersion !== 1} onClick={() => void selectionOperation('UndoSelection')}>Undo new selection</button>
        </>}
      </div><p className="caption">Undo removes this new note and its exclusive excerpts. Shared sources remain.</p>
    </div>}
    {note && <NoteManagement key={note.id} note={note} generation={generation} disabled={dirty || busy || !!pending.current || !!selectionAction} pendingChange={setManagementPending} changed={async id => { openedQuery.current = id; selectNote(id, true); await open(id); await refresh(0); setNotice('Change saved in history.'); }} />}
    {note && <NoteSources sources={sources} generation={generation} checks={sourceChecks} onCheck={checkOriginalSource} />}
    <p role="status">{notice}{dirty ? ' Unsaved draft — keep this page open.' : ''}</p>
    {failure && <div role="alert"><strong>{failure.code}</strong><p>{failure.message}</p>{pending.current && <p>Resolve this save with Retry before editing or switching notes.</p>}</div>}
    {conflict && <div className="conflict"><h3>Latest saved version {conflict.recordVersion}</h3><SafeMarkdown body={conflict.bodyMarkdown} /><NoteMetadata note={conflict} />
      <p>Your draft remains in the editor. Compare every field before choosing.</p>
      <div className="actions"><button onClick={() => { setNote(conflict); setSources(conflictSources); setHistory(conflictHistory); setHistoryOffset(0); setConflict(undefined); }}>Keep my draft against this version</button><button onClick={() => { adopt(conflict); setSources(conflictSources); setHistory(conflictHistory); setHistoryOffset(0); }}>Use latest saved version</button></div></div>}
    {!!history.length && <NoteHistory history={history} note={note} historyOffset={historyOffset} historical={historical}
      historicalSources={historicalSources} disabled={!canSwitch} onOpenRevision={openRevision} onPage={historyPage} />}
    </>}
    </div>
    {switchRequest && createPortal(<dialog className="draft-dialog" ref={switchDialog} aria-labelledby="draft-dialog-title" onCancel={event => { event.preventDefault(); cancelSwitch(); }}>
      <h2 id="draft-dialog-title">Unsaved note</h2>
      <p>Your current draft is still open. Save or discard it before opening another note, or cancel to keep editing. The current address is kept until you choose.</p>
      {failure && <p role="alert">{failure.code}: {failure.message} Cancel switching to return to your draft in Knowledge{conflict ? ' and compare the latest saved version' : ''}.</p>}
      {(pending.current || selectionAction || managementPending) && <p role="alert">An action is awaiting confirmation. Retry it in the current note before switching; its original request must be preserved.</p>}
      <div className="actions">
        <button disabled={busy || !!conflict || !!selectionAction || managementPending || !draft.bodyMarkdown.trim()} onClick={async () => {
          if (await save()) { setSwitchRequest(undefined); switchRequest.proceed(); }
        }}>Save and switch</button>
        <button className="secondary" disabled={busy || !!pending.current || !!selectionAction || managementPending} onClick={() => { adopt(note); setSwitchRequest(undefined); switchRequest.proceed(); }}>Discard and switch</button>
        <button className="secondary" onClick={cancelSwitch}>Cancel switching</button>
      </div>
    </dialog>, document.body)}
  </section>;
}
