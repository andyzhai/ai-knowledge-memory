import { useEffect, useRef, useState } from 'react';
import { isId } from '../shared/knowledge';
import type { ArchiveDetail, ArchiveRead, ArchiveReply, ArchiveSummary } from '../shared/loaded-capture';
import type { SearchDocument, SearchOptions } from '../shared/search';
import { SearchSession, type SearchView } from './SearchSession';
import { ArchiveSourceAddition, DeleteControl } from './Management';
import { safeLink } from '../shared/markdown';
import { locationHref } from './navigation';

async function read(command: ArchiveRead) {
  const reply = await chrome.runtime.sendMessage(command) as ArchiveReply;
  if (!reply?.ok) throw new Error(reply && 'code' in reply ? reply.code : 'Archive unavailable');
  return reply;
}
export function ArchiveDetailView({ captureId, revisionId, close, selectCapture, compact = false }: { compact?: boolean; captureId: string; revisionId?: string; close: () => void; selectCapture?: (id: string) => void }) {
  const Title = compact ? 'h2' : 'h3';
  const MessageHeading = compact ? 'h3' : 'h4';
  const [detail, setDetail] = useState<ArchiveDetail>();
  const [generation, setGeneration] = useState('');
  const [notice, setNotice] = useState('Loading local capture…');
  const [history, setHistory] = useState<ArchiveSummary[]>([]);
  const [selected, setSelected] = useState(captureId);
  const [historyOffset, setHistoryOffset] = useState(0), [historyTotal, setHistoryTotal] = useState(0);
  const serial = useRef(0);
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!detail || !article.current?.checkVisibility()) return;
    const match = Array.from(article.current.querySelectorAll<HTMLElement>('[data-revision-id]')).find(node => node.dataset.revisionId === revisionId);
    if (match) { match.focus({ preventScroll: true }); match.scrollIntoView({ block: 'nearest' }); }
    else article.current.querySelector<HTMLElement>('.capture-title')?.focus({ preventScroll: true });
  }, [detail, revisionId]);
  async function load(id: string, offset = 0, seekMatch = false) {
    const token = ++serial.current; setNotice('Loading local capture…'); setDetail(undefined);
    try {
      const state = await read({ protocolVersion: 1, type: 'ListArchiveCaptures', offset: 0, conversationId: null });
      if (token !== serial.current) return;
      const reply = await read({ protocolVersion: 1, type: 'GetArchiveCapture', generation: state.generation, captureId: id, offset });
      if (token !== serial.current || !('detail' in reply)) return;
      if (seekMatch && revisionId && id === captureId) {
        const position = reply.detail.capture.revisionIds.indexOf(revisionId);
        if (position >= 8) { await load(id, Math.floor(position / 8) * 8); return; }
      }
      setGeneration(reply.generation); setDetail(reply.detail); setSelected(id);
      setNotice(revisionId && id === captureId && !reply.detail.capture.revisionIds.includes(revisionId) ? 'The requested revision is not part of this capture. Showing its retained messages.' : '');
      const rows = await read({ protocolVersion: 1, type: 'ListArchiveCaptures', offset: 0, conversationId: reply.detail.capture.conversationId });
      if (token === serial.current && 'captures' in rows) { setHistory(rows.captures); setHistoryOffset(0); setHistoryTotal(rows.total); }
    } catch (error) { if (token === serial.current) setNotice(error instanceof Error ? error.message : 'Archive unavailable'); }
  }
  useEffect(() => { void load(captureId, 0, true); return () => { ++serial.current; }; }, [captureId, revisionId]);
  async function historyPage(offset: number) {
    if (!detail) return;
    const token = serial.current;
    try { const rows = await read({ protocolVersion: 1, type: 'ListArchiveCaptures', offset, conversationId: detail.capture.conversationId }); if (token === serial.current && 'captures' in rows && rows.generation === generation) { setHistory(rows.captures); setHistoryOffset(offset); setHistoryTotal(rows.total); } }
    catch { if (token === serial.current) setNotice('Capture history could not be read. Refresh to retry.'); }
  }
  return <article ref={article} aria-label="Archive capture detail">
    <button className="secondary" onClick={close}>Back to conversations</button>
    <Title className="capture-title" tabIndex={-1}>{detail?.title ?? 'Archive capture'}</Title><p role="status">{notice}</p>
    {compact && <p><a href={locationHref({ destination: 'archive', captureId: selected, revisionId }, chrome.runtime.getURL('library.html'))} target="_blank" rel="noopener noreferrer">Open conversation in full library</a></p>}
    {detail && <>
      <p><strong>{detail.capture.captureStatus.replaceAll('_', ' ')}</strong> · {detail.capture.revisionIds.length} committed messages · {detail.capture.scope.replaceAll('_', ' ')} · {new Date(detail.capture.capturedAt).toLocaleString()}</p>
      <p className="capture-warning">Loaded content only. Earlier history and unobserved branches may be missing.</p>
      {detail.capture.interruptionReason && <p>Interrupted: {detail.capture.interruptionReason.replaceAll('_', ' ')}. Committed messages remain available below.</p>}
      <details><summary>Capture fidelity and completion</summary><p>Capture completion is separate from response completion. {detail.capture.warnings.map(w => w.replaceAll('_', ' ')).join('; ') || 'No additional capture warnings.'}</p></details>
      <ol className="conversation-messages" start={detail.offset + 1}>{detail.revisions.map((revision, index) => <li tabIndex={-1} className={revision.id === revisionId ? 'matching-message' : ''} key={`${revision.id}-${index}`} data-revision-id={revision.id}>
        <div className="message-heading"><MessageHeading>{revision.role === 'user' ? 'You' : revision.role === 'assistant' ? 'Assistant' : revision.role}</MessageHeading><span className="caption">{detail.offset + index + 1} · {revision.contentScope.replaceAll('_', ' ')} · response {detail.capture.membership[detail.offset + index]?.completion ?? 'unknown'}</span></div>
        {revision.id === revisionId && <p className="match-label">Matching revision</p>}
        {revision.blocks.map((block, i) => <div key={i}>
          {block.kind === 'code' && <p className="caption">Code · {block.language ?? 'language unknown'}</p>}
          {block.text && (block.kind === 'code' ? <pre className="archive-code"><code>{block.text}</code></pre> : <div className={`archive-text block-${block.kind}`}>{block.text}</div>)}
          {(block.kind === 'link' || block.kind === 'citation') && (block.url && safeLink(block.url) ? <a href={safeLink(block.url)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{block.url}</a> : <p>Link destination unavailable</p>)}
        </div>)}
        <button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(revision.plainText); setNotice('Copied exact visible message text.'); } catch { setNotice('Select the visible text to copy manually.'); } }}>Copy message text</button>
        {!compact && <ArchiveSourceAddition generation={generation} captureId={detail.capture.id} revisionId={revision.id} text={revision.plainText} />}
      </li>)}</ol>
      <div className="actions"><button disabled={detail.offset === 0} onClick={() => void load(selected, Math.max(0, detail.offset - 8))}>Previous messages</button>
        <span className="caption">{detail.offset + 1}–{detail.offset + detail.revisions.length} of {detail.capture.revisionIds.length}</span>
        <button disabled={detail.offset + detail.revisions.length >= detail.capture.revisionIds.length} onClick={() => void load(selected, detail.offset + 8)}>Next messages</button></div>
      <details><summary>Capture history and observed variants</summary><p>Each capture preserves its own order. Missing messages do not imply deletion; unknown identities remain separate observations.</p>
        <ul>{history.map(capture => <li key={capture.id}><button onClick={() => selectCapture ? selectCapture(capture.id) : void load(capture.id)}>{new Date(capture.capturedAt).toLocaleString()} · {capture.scope.replaceAll('_', ' ')} · {capture.captureStatus} · {capture.messages} messages</button></li>)}</ul>
        <button disabled={!historyOffset} onClick={() => void historyPage(Math.max(0, historyOffset - 50))}>Newer captures</button><button disabled={historyOffset + history.length >= historyTotal} onClick={() => void historyPage(historyOffset + 50)}>Older captures</button>
      </details>
      {detail.url && safeLink(detail.url) && <p><a href={safeLink(detail.url)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open original conversation</a> · Original location is unverified until checked on the source page.</p>}
      {!compact && <details className="context-section"><summary>Manage this conversation</summary>
      <DeleteControl generation={generation} target={{ kind: 'conversation', conversationId: detail.capture.conversationId, mode: 'keep_knowledge' }} label="Delete conversation, keep Knowledge excerpts" />
      <DeleteControl generation={generation} target={{ kind: 'conversation', conversationId: detail.capture.conversationId, mode: 'with_knowledge' }} label="Remove source and all dependent content permanently" />
      </details>}
    </>}
  </article>;
}
type CaptureSelection = { captureId?: string; revisionId?: string };
export function ArchiveSearch({ active = true, selection, selectCapture, compact = false }: { compact?: boolean; active?: boolean; selection?: CaptureSelection; selectCapture?: (captureId?: string, revisionId?: string) => void }) {
  const [query, setQuery] = useState(''), [options, setOptions] = useState<SearchOptions>({});
  const [view, setView] = useState<SearchView>({ phase: 'loading', message: 'Loading Archive on demand…', documents: [] });
  const [captures, setCaptures] = useState<ArchiveSummary[]>([]), [offset, setOffset] = useState(0), [total, setTotal] = useState(0);
  const [notice, setNotice] = useState('');
  const [localDetail, setLocalDetail] = useState<CaptureSelection>(() => {
    const id = new URLSearchParams(location.search).get('capture'); const revision = new URLSearchParams(location.search).get('revision'); return { captureId: isId(id) ? id : '', revisionId: isId(revision) ? revision : undefined };
  });
  const detail = selection ?? localDetail;
  const returnTarget = useRef<HTMLElement | null>(null);
  function setDetail(next: CaptureSelection) {
    if (next.captureId && document.activeElement?.classList.contains('archive-open')) returnTarget.current = document.activeElement as HTMLElement;
    if (selectCapture) selectCapture(next.captureId, next.revisionId);
    else setLocalDetail(next);
    if (!next.captureId) requestAnimationFrame(() => {
      const target = returnTarget.current;
      if (target?.isConnected && target.checkVisibility()) target.focus();
      else root.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    });
  }
  const session = useRef<SearchSession | null>(null), root = useRef<HTMLElement>(null);
  const recentSerial = useRef(0);
  const queryRef = useRef(query); queryRef.current = query;
  const optionsRef = useRef(options); optionsRef.current = options;
  async function recent(at = 0) {
    const token = ++recentSerial.current;
    try { const reply = await read({ protocolVersion: 1, type: 'ListArchiveCaptures', offset: at, conversationId: null }); if (token === recentSerial.current && 'captures' in reply) { setCaptures(reply.captures); setOffset(at); setTotal(reply.total); } }
    catch { if (token === recentSerial.current) setNotice('Archive could not be read. Refresh to retry.'); }
  }
  useEffect(() => {
    if (!active) { setView({ phase: 'loading', message: 'Loading Archive on demand…', documents: [] }); return; }
    const current = new SearchSession(setView, undefined, 'archive'); session.current = current;
    current.update(queryRef.current, optionsRef.current);
    void recent(offset).then(() => current.rebuild());
    const focus = () => { void current.reconcile(); };
    const changed = (message: { type?: string; generation?: string; dataSeq?: number }, sender: chrome.runtime.MessageSender) => {
      if (sender.id === chrome.runtime.id && message.type === 'KnowledgeChanged' && message.generation && message.dataSeq !== undefined) { current.changed(message.generation, message.dataSeq); void recent(); }
    };
    const storage = (changes: Record<string, chrome.storage.StorageChange>) => { if (changes.activeLibrary) { setDetail({ captureId: '' }); void recent(); void current.rebuild(); } };
    window.addEventListener('focus', focus); chrome.runtime.onMessage.addListener(changed); chrome.storage.onChanged.addListener(storage);
    return () => { ++recentSerial.current; current.dispose(); session.current = null; window.removeEventListener('focus', focus); chrome.runtime.onMessage.removeListener(changed); chrome.storage.onChanged.removeListener(storage); };
  }, [active]);
  useEffect(() => { session.current?.update(query, options); }, [query, options]);
  const groups = new Map<string, { document: SearchDocument; snippet: string }[]>();
  for (const hit of view.result?.hits ?? []) {
    const document = view.documents.find(d => d.note.id === hit.id); if (!document?.archive) continue;
    const group = groups.get(document.archive.conversationId) ?? []; group.push({ document, snippet: hit.snippet.text }); groups.set(document.archive.conversationId, group);
  }
  const browsing = !query.trim() && !Object.values(options.filters ?? {}).some(Boolean);
  return <section ref={root} aria-label="Archive recall" className="archive-workspace" data-has-detail={!!detail.captureId} onKeyDown={event => {
    if (event.key === 'Escape') { setDetail({ captureId: '' }); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLElement && event.target.classList.contains('archive-open')))) return;
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.archive-open') ?? []); if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(event.target as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }}>
    <div className="archive-browser" hidden={compact && !!detail.captureId}>
    <h2 className={compact ? 'visually-hidden' : undefined}>Captured conversations</h2>
    {!compact && <p className="caption">Captured sources · separate from Knowledge</p>}
    <label>Search Archive<input type="search" maxLength={1000} value={query} onChange={e => setQuery(e.target.value)} /></label>
    <details><summary>Filter Archive</summary>
    <div className="search-checks"><label><input type="checkbox" checked={!!options.filters?.includePreviousVersions} onChange={e => setOptions(o => ({ ...o, filters: { ...o.filters, includePreviousVersions: e.target.checked } }))} /> Include previous versions</label>
      <label><input type="checkbox" checked={!!options.broaden} onChange={e => setOptions(o => ({ ...o, broaden: e.target.checked }))} /> Broaden Archive search (OR)</label>
      <label><input type="checkbox" checked={!!options.fuzzy} onChange={e => setOptions(o => ({ ...o, fuzzy: e.target.checked }))} /> Include similar Archive spellings</label></div>
    <label>Provider<select value={options.filters?.provider ?? ''} onChange={e => setOptions(o => ({ ...o, filters: { ...o.filters, provider: e.target.value as 'chatgpt' || undefined } }))}><option value="">All providers</option><option value="chatgpt">ChatGPT</option></select></label>
      <label>Captured from<input type="date" onChange={e => setOptions(o => ({ ...o, filters: { ...o.filters, dateFrom: e.target.value || undefined } }))} /></label>
      <label>Captured through<input type="date" onChange={e => setOptions(o => ({ ...o, filters: { ...o.filters, dateTo: e.target.value || undefined } }))} /></label></details>
    <p className="caption" role="status" data-archive-phase={view.phase}>{browsing && view.phase === 'ready' ? `${total} recent captures · stored on this device` : view.message}</p>
    {!browsing && <>
    {view.phase === 'ready' && !view.result?.hits.length && <p>No matching Archive messages.</p>}
    <ul className="compact-results archive-groups" aria-label="Archive search results">{[...groups].map(([id, group]) => <li key={id}><h3>{group[0]!.document.archive!.title}</h3><ol>{group.map(({ document, snippet }) => <li key={document.note.id}>
      <button className="archive-open list-item" aria-current={detail.captureId === document.archive!.captureId && detail.revisionId === document.note.id ? 'true' : undefined} aria-label={`Open ${document.archive!.role} source`} onClick={() => setDetail({ captureId: document.archive!.captureId, revisionId: document.note.id })}>
      <span className="list-preview">{snippet}</span><span className="caption">{document.archive!.role} · {document.archive!.status} · {document.archive!.latest ? 'latest' : 'previous version'} · {new Date(document.note.createdAt).toLocaleDateString()}</span></button>
    </li>)}</ol></li>)}</ul>
    {(view.result?.total ?? 0) > 50 && <p>Showing 50 of {view.result!.total} eligible revisions. Narrow the query or filters to see others.</p>}
    </>}
    {browsing && <div>
      {!captures.length && view.phase === 'ready' && <p>No captured conversations yet. Use Save loaded conversation on an enabled ChatGPT page.</p>}
      <ul className="compact-results" aria-label="Recent captures">{captures.map(c => <li key={c.id}><button className="archive-open list-item" aria-current={detail.captureId === c.id ? 'true' : undefined} onClick={() => setDetail({ captureId: c.id })}><h3>{c.title}</h3><span className="caption">{c.captureStatus.replaceAll('_', ' ')} · {c.messages} messages</span><span className="caption">{new Date(c.capturedAt).toLocaleString()}</span></button></li>)}</ul>
      {total > 50 && <div className="actions">
      <button disabled={!offset} onClick={() => void recent(Math.max(0, offset - 50))}>Newer Archive captures</button><button disabled={offset + captures.length >= total} onClick={() => void recent(offset + 50)}>Older Archive captures</button>
      </div>}
    </div>}
    <button className="secondary refresh-list" onClick={() => { void recent(offset); void session.current?.rebuild(); }}>Refresh Archive</button><p role="status">{notice}</p>
    </div>
    {detail.captureId && <ArchiveDetailView compact={compact} captureId={detail.captureId} revisionId={detail.revisionId} selectCapture={id => setDetail({ captureId: id })} close={() => setDetail({})} />}
    {!compact && !detail.captureId && <div className="archive-empty"><h2>Select a conversation</h2><p>Browse recent captures or search for a message to read its exact retained source.</p></div>}
  </section>;
}
