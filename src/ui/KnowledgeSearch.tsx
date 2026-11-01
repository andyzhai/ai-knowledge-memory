import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NOTE_TYPES } from '../shared/knowledge';
import type { SearchDocument, SearchHit, SearchOptions } from '../shared/search';
import { SearchSession, type SearchView, type MeaningView } from './SearchSession';
import { ArchiveSearch } from './Archive';
import { SafeMarkdown } from './SafeMarkdown';

function Snippet({ snippet }: { snippet: SearchHit['snippet'] }) {
  if (snippet.matchStart === undefined || snippet.matchEnd === undefined) return <>{snippet.text}</>;
  const points = Array.from(snippet.text), start = snippet.matchStart - snippet.start, end = snippet.matchEnd - snippet.start;
  return <>{points.slice(0, start).join('')}<mark>{points.slice(start, end).join('')}</mark>{points.slice(end).join('')}</>;
}

export function KnowledgeSearch({ active = true, allowArchive = true, openNote, selectedId, recent }: { active?: boolean; allowArchive?: boolean; openNote?: (id: string) => void; selectedId?: string; recent?: ReactNode }) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchOptions>({});
  const [collection, setCollection] = useState(allowArchive && new URLSearchParams(location.search).has('capture') ? 'archive' : 'knowledge');
  const [view, setView] = useState<SearchView>({ phase: 'loading', message: 'Loading local Knowledge…', documents: [] });
  const [visible, setVisible] = useState(20);
  const [detail, setDetail] = useState<SearchDocument>();
  const [notice, setNotice] = useState('');
  const [meaningEnabled, setMeaningEnabled] = useState(false);
  const [meaning, setMeaning] = useState<MeaningView>({ phase: 'disabled', message: '', documents: [] });
  const session = useRef<SearchSession | null>(null);
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null), returnTarget = useRef<HTMLElement | null>(null);
  function recall(document: SearchDocument) { returnTarget.current = window.document.activeElement as HTMLElement; setDetail(document); }
  function closeDetail() {
    setDetail(undefined);
    requestAnimationFrame(() => { if (returnTarget.current?.isConnected) returnTarget.current.focus(); else input.current?.focus(); });
  }
  useEffect(() => { if (detail) detailHeading.current?.focus(); }, [detail]);
  const optionsRef = useRef(options); optionsRef.current = options;
  const queryRef = useRef(query); queryRef.current = query;
  useEffect(() => {
    if (!active || collection !== 'knowledge') {
      setView({ phase: 'loading', message: 'Loading local Knowledge…', documents: [] });
      setDetail(undefined); setMeaningEnabled(false);
      setMeaning({ phase: 'disabled', message: '', documents: [] });
      return;
    }
    const current = new SearchSession(next => { setView(next); setDetail(undefined); setNotice(''); }, next => { setMeaning(next); setDetail(undefined); });
    session.current = current;
    current.update(queryRef.current, optionsRef.current); void current.rebuild();
    const focus = () => { void current.reconcile(); };
    const changed = (message: { type?: string; generation?: string; dataSeq?: number }, sender: chrome.runtime.MessageSender) => {
      if (sender.id === chrome.runtime.id && message.type === 'KnowledgeChanged' && typeof message.generation === 'string' && typeof message.dataSeq === 'number') current.changed(message.generation, message.dataSeq);
    };
    const storageChanged = (changes: Record<string, chrome.storage.StorageChange>) => { if (changes.activeLibrary) void current.rebuild(); };
    window.addEventListener('focus', focus); chrome.runtime.onMessage.addListener(changed); chrome.storage.onChanged.addListener(storageChanged);
    return () => { current.dispose(); session.current = null; window.removeEventListener('focus', focus); chrome.runtime.onMessage.removeListener(changed); chrome.storage.onChanged.removeListener(storageChanged); };
  }, [active, collection]);
  useEffect(() => { session.current?.update(query, options); setVisible(20); setDetail(undefined); }, [query, options]);
  useEffect(() => { session.current?.setSemantic(meaningEnabled && collection === 'knowledge'); }, [meaningEnabled, collection]);
  function filter<K extends keyof NonNullable<SearchOptions['filters']>>(key: K, value: NonNullable<SearchOptions['filters']>[K]) {
    setOptions(current => ({ ...current, filters: { ...current.filters, [key]: value } }));
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice('Copied retained text.'); }
    catch { setNotice('Clipboard unavailable. Select and copy the visible text manually.'); }
  }
  const documents = new Map(view.documents.map(document => [document.note.id, document]));
  const filters = options.filters ?? {};
  const browsing = !!recent && !query.trim() && !Object.values(filters).some(Boolean);
  return <section ref={root} aria-label="Knowledge recall" onKeyDown={event => {
    if (event.key === 'Escape' && collection === 'knowledge') { if (detail) closeDetail(); else { setQuery(''); input.current?.focus(); } }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (event.target !== input.current && !(event.target instanceof HTMLElement && event.target.classList.contains('search-open'))) return;
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.search-open') ?? []);
    if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(event.target as HTMLButtonElement);
    buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }}>
    {allowArchive && <><label htmlFor="search-collection">Search collection</label>
    <select id="search-collection" value={collection} onChange={event => setCollection(event.target.value)}><option value="knowledge">Knowledge</option><option value="archive">Archive</option></select></>}
    {collection === 'archive' ? <ArchiveSearch compact /> : <>
      <div hidden={!!detail && allowArchive}>
      <label htmlFor="query">Search saved Knowledge</label>
      <input ref={input} autoFocus={allowArchive} id="query" type="search" maxLength={1000} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search saved notes…" onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); root.current?.querySelector<HTMLButtonElement>('.search-open')?.click(); }
      }} />
      <details><summary>Filter Knowledge</summary>
      <p className="caption">All terms match by default. Use quotes for a contiguous phrase. Only the last term (3+ characters) can match a prefix. ↓/↑ moves through results; Enter opens; Escape clears.</p>
      <div className="search-checks"><label><input type="checkbox" checked={!!options.broaden} onChange={event => setOptions(current => ({ ...current, broaden: event.target.checked }))} /> Broaden search (OR)</label>
        <label><input type="checkbox" checked={!!options.fuzzy} onChange={event => setOptions(current => ({ ...current, fuzzy: event.target.checked }))} /> Include similar spellings</label></div>
      <div className="search-filters">
        <label>Source provider<select aria-label="Source provider" value={filters.provider ?? ''} onChange={event => filter('provider', event.target.value as NonNullable<SearchOptions['filters']>['provider'] || undefined)}><option value="">All providers</option><option value="manual">Manual</option><option value="chatgpt">ChatGPT</option><option value="gemini">Gemini</option><option value="perplexity">Perplexity</option></select></label>
        <label>Note type<select aria-label="Note type" value={filters.type ?? ''} onChange={event => filter('type', event.target.value as NonNullable<SearchOptions['filters']>['type'] || undefined)}><option value="">All types</option>{NOTE_TYPES.map(type => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}</select></label>
        <label>Exact tag<input aria-label="Exact tag" value={filters.tag ?? ''} onChange={event => filter('tag', event.target.value || undefined)} /></label>
        <label>Review state<select aria-label="Review state filter" value={filters.reviewState ?? ''} onChange={event => filter('reviewState', event.target.value as NonNullable<SearchOptions['filters']>['reviewState'] || undefined)}><option value="">Saved, endorsed, needs review</option>{['saved', 'endorsed', 'needs_review', 'superseded'].map(state => <option key={state} value={state}>{state.replaceAll('_', ' ')}</option>)}</select></label>
        <label>Date basis<select value={filters.dateField ?? 'saved'} onChange={event => filter('dateField', event.target.value as 'saved' | 'reviewed')}><option value="saved">Saved date</option><option value="reviewed">User review date</option></select></label>
        <label>From date<input type="date" value={filters.dateFrom ?? ''} onChange={event => filter('dateFrom', event.target.value || undefined)} /></label>
        <label>Through date<input type="date" value={filters.dateTo ?? ''} onChange={event => filter('dateTo', event.target.value || undefined)} /></label>
      </div><label className="search-checks"><input type="checkbox" checked={!!filters.includeOutdated} onChange={event => filter('includeOutdated', event.target.checked)} /> Include outdated (superseded)</label>
      <label className="search-checks"><input type="checkbox" checked={!!filters.includeExcluded} onChange={event => filter('includeExcluded', event.target.checked)} /> Include excluded notes</label>
      <button onClick={() => void session.current?.rebuild()}>Rebuild search index</button>
      {__H_EXPERIMENT__ && <div>
        <label><input type="checkbox" checked={meaningEnabled} onChange={event => setMeaningEnabled(event.target.checked)} /> Enable local meaning experiment for this view</label>
        <p className="caption">Packaged multilingual MiniLM · 135.4 MB model assets · CPU inference only while this view is open. No text or queries leave this device. Disabling releases the worker and volatile vectors. To remove packaged assets, install the ordinary lexical build.</p>
        <p role="status" data-meaning-phase={meaning.phase}>{meaning.message}</p>
      </div>}</details>
      <p className="caption" role="status" data-search-phase={view.phase} data-search-ms={view.elapsedMs}>{(browsing || !query.trim()) && view.phase === 'ready' ? 'Recent notes · stored on this device' : view.message}</p>
      {browsing ? recent : <>
      {allowArchive && <h2 className="visually-hidden">Knowledge results</h2>}
      {view.phase === 'ready' && !view.result?.hits.length && !view.result?.error && <p>{query.trim() ? 'No matching Knowledge. Try fewer terms or broaden the search.' : 'No eligible Knowledge yet. Save a selection or write a note in the full library.'}</p>}
      <ol className="results compact-results" aria-label="Knowledge search results">{view.result?.hits.slice(0, visible).map(hit => {
        const document = documents.get(hit.id); if (!document) return null;
        if (openNote) return <li key={hit.id}><button className="search-open list-item" aria-current={selectedId === hit.id ? 'true' : undefined} aria-label={`Recall ${document.note.title || 'Untitled note'}`} onClick={() => openNote(hit.id)}>
          <h3>{document.note.title || 'Untitled note'}</h3><span className="list-preview"><Snippet snippet={hit.snippet} /></span>
          <span className="caption">{document.note.reviewState.replaceAll('_', ' ')} · {document.note.type.replaceAll('_', ' ')}</span>
          <span className="caption match-reason">{hit.reason}</span>
        </button></li>;
        return <li key={hit.id}><button className="search-open list-item" aria-label={`Recall ${document.note.title || 'Untitled note'}`} onClick={() => recall(document)}>
          <h3>{document.note.title || 'Untitled note'}</h3><span className="list-preview"><Snippet snippet={hit.snippet} /></span>
          <span className="caption">{document.note.reviewState.replaceAll('_', ' ')} · {new Date(document.note.createdAt).toLocaleDateString()}</span></button>
          <button className="secondary copy-excerpt" onClick={() => void copy(hit.snippet.text)}>Copy excerpt</button>
        </li>;
      })}</ol>
      {!!view.result && view.result.hits.length > visible && <button onClick={() => setVisible(50)}>Show remaining results (up to 50)</button>}
      {!!view.result && view.result.total > 50 && <p>Showing the best 50 of {view.result.total} eligible notes. Narrow the query or filters to see others.</p>}
      </>}
      {__H_EXPERIMENT__ && meaningEnabled && meaning.phase === 'ready' && <section aria-label="Related by meaning">
        <h3>Related by meaning</h3><p>Suggestions only; these may not answer your query. Exact lexical matches above keep their order.</p>
        <ol>{meaning.result?.hits.slice(0, 5).map(hit => {
          const document = meaning.documents.find(document => document.note.id === hit.id); if (!document) return null;
          return <li key={hit.id}><button onClick={() => openNote ? openNote(document.note.id) : recall(document)}>{document.note.title || 'Untitled note'}</button>
            <p className="caption">{document.note.reviewState.replaceAll('_', ' ')} · {document.providers.join(', ')}</p>
            <p>{hit.reason}</p><p><Snippet snippet={hit.snippet} /></p></li>;
        })}</ol>
      </section>}
      </div>
      {detail && <article aria-label="Recalled note"><button className="secondary" onClick={closeDetail}>Back to results</button>
        <h2 ref={detailHeading} tabIndex={-1}>{detail.note.title || 'Untitled note'}</h2><p className="caption">{detail.note.reviewState.replaceAll('_', ' ')} · {new Date(detail.note.createdAt).toLocaleDateString()}</p>
        <a href={chrome.runtime.getURL(`library.html?note=${detail.note.id}`)} target="_blank" rel="noopener noreferrer">Open note in full library</a>
        <SafeMarkdown body={detail.note.bodyMarkdown} /><div className="actions"><button onClick={() => void copy(detail.note.plainText)}>Copy visible note</button></div>
        <details><summary>Exact saved Markdown</summary><pre>{detail.note.bodyMarkdown}</pre><button onClick={() => void copy(detail.note.bodyMarkdown)}>Copy visible Markdown</button></details>
      </article>}
      <p role="status">{notice}</p>
    </>}
  </section>;
}
