import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CHATGPT_MATCH, type Reply, type Status } from '../shared/protocol';
import { ManualLibrary } from './ManualLibrary';
import { KnowledgeSearch } from './KnowledgeSearch';
import { LibraryCleanup } from './Management';
import { BackupControls } from './Backup';
import { ArchiveSearch } from './Archive';
import { locationHref, readLocation, useLibraryNavigation, type Destination } from './navigation';
import './styles.css';

const destinations: { id: Destination; label: string; path: string }[] = [
  { id: 'knowledge', label: 'Knowledge', path: 'M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1m0-15c3-2 6-2 9-1v15c-3-1-6-1-9 1V5Z' },
  { id: 'archive', label: 'Archive', path: 'M4 8v12h16V8M3 3h18v5H3V3Zm6 9h6' },
  { id: 'settings', label: 'Settings', path: 'M4 7h16M4 17h16M8 4v6m8 4v6' },
];

function App() {
  const fullTab = location.pathname === '/library.html';
  const navigation = useLibraryNavigation();
  const destination = navigation.current.destination;
  const heading = useRef<HTMLHeadingElement>(null);
  const previousDestination = useRef(destination);
  useEffect(() => {
    if (previousDestination.current !== destination) {
      window.scrollTo(0, 0); heading.current?.focus();
      previousDestination.current = destination;
    }
  }, [destination]);
  const saveDiagnostic = new URLSearchParams(location.search).get('saveError');
  const diagnosticCode = saveDiagnostic ?? new URLSearchParams(location.search).get('previewError');
  const previewDiagnostics: Record<string, string> = {
    PERMISSION_DENIED: 'ChatGPT preview is disabled or site access is unavailable. Enable ChatGPT preview in Settings, then retry on the source page.',
    CONTENT_SCRIPT_UNAVAILABLE: 'The source-page preview script did not respond. Reload the ChatGPT tab and retry. No selection was captured.',
    SOURCE_TAB_UNAVAILABLE: 'The source tab is no longer available. Open the conversation and try again.',
    PROBE_UNAVAILABLE: 'The preview could not initialize. Reload the extension and source tab, then retry.',
  };
  const knownDiagnostic = diagnosticCode && Object.hasOwn(previewDiagnostics, diagnosticCode) ? diagnosticCode : 'PROBE_UNAVAILABLE';
  const [status, setStatus] = useState<Status>();
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [windowId, setWindowId] = useState<number>();
  async function refresh() {
    const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'GetStatus' }) as Reply;
    if (reply?.ok) setStatus(reply.status);
    else setNotice('The probe could not initialize. Reload the extension and try again.');
  }
  useEffect(() => {
    void chrome.windows.getCurrent().then(window => setWindowId(window.id));
    void refresh().catch(() => setNotice('Open this page from the installed extension.'));
    const update = () => { void refresh().catch(() => undefined); };
    chrome.storage.onChanged.addListener(update);
    chrome.permissions.onRemoved.addListener(update);
    return () => {
      chrome.storage.onChanged.removeListener(update);
      chrome.permissions.onRemoved.removeListener(update);
    };
  }, []);
  async function enable() {
    setBusy(true); setNotice(''); setNoticeError(false);
    try {
      // Permission request must be initiated directly by this button gesture.
      const granted = await chrome.permissions.request({ origins: [CHATGPT_MATCH] });
      if (!granted) { setNotice('Access was not granted. Local Knowledge search remains available.'); return; }
      const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'SetProviderEnabled', enabled: true }) as Reply;
      if (!reply?.ok) throw new Error('enable');
      setStatus(reply.status); setNotice('ChatGPT capture controls are enabled.');
    } catch { setNoticeError(true); setNotice('Could not enable ChatGPT. Try again or check site access in Chrome.'); }
    finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true); setNotice(''); setNoticeError(false);
    try {
      const reply = await chrome.runtime.sendMessage({ protocolVersion: 1, type: 'SetProviderEnabled', enabled: false }) as Reply;
      if (!reply?.ok) throw new Error('disable');
      await chrome.permissions.remove({ origins: [CHATGPT_MATCH] });
      await refresh(); setNotice('ChatGPT access removed. Existing preview controls are stopped.');
    } catch { setNoticeError(true); setNotice('Could not remove ChatGPT access. Check site access in Chrome extension settings.'); }
    finally { setBusy(false); }
  }
  const diagnostics = diagnosticCode && <section role="alert" aria-label="Preview unavailable">
      <h2>{saveDiagnostic ? 'Selection save' : 'Preview'} unavailable: {knownDiagnostic}</h2>
      <p>{previewDiagnostics[knownDiagnostic]}</p>
      <p>Nothing was saved. Site access has not been changed.</p>
      <a href={chrome.runtime.getURL('library.html?view=settings')} target="_blank" rel="noopener noreferrer">Open integration settings</a>
    </section>;
  if (!fullTab) return <main className="app recall-panel">
    <header><h1>Recall</h1>
      <a href={chrome.runtime.getURL('library.html')} target="_blank" rel="noopener noreferrer">Open full library</a></header>
    {diagnostics}
    <KnowledgeSearch />
    <footer><a href={chrome.runtime.getURL('library.html?view=settings')} target="_blank" rel="noopener noreferrer">Integration, backup and settings</a>
      </footer>
  </main>;
  return <div className="library-shell">
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <header className="shell-header"><p className="brand"><span className="brand-mark" aria-hidden="true">K</span>AI Knowledge Memory</p>
      <button className="secondary" disabled={windowId === undefined} onClick={() => {
        if (windowId !== undefined) void chrome.sidePanel.open({ windowId }).catch(() => setNotice('Could not open recall. Use the toolbar action.'));
      }}>Open recall panel</button>
    </header>
    <div className="shell-body">
      <nav className="sidebar" aria-label="Primary navigation">
        {destinations.map(item => <a key={item.id} href={locationHref(navigation.remembered[item.id])} aria-current={destination === item.id ? 'page' : undefined} onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); navigation.navigate(navigation.remembered[item.id]);
        }}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={item.path} /></svg>{item.label}</a>)}
        <p className="sidebar-caption">Your local library</p>
      </nav>
      <main id="workspace" className="workspace" tabIndex={-1}>
        <h1 ref={heading} tabIndex={-1}>{destinations.find(item => item.id === destination)!.label}</h1>
        {diagnostics}
        {/* Keep editors and pending maintenance controls mounted across navigation.
            LibraryGate still unmounts every destination at the A5/A6 barrier. */}
        <div hidden={destination !== 'knowledge'} className="knowledge-workspace">
          <ManualLibrary noteId={navigation.remembered.knowledge.noteId} selectNote={navigation.selectNote}
            active={destination === 'knowledge'} navigationGuard={navigation.guard} />
        </div>
        <div hidden={destination !== 'archive'}>
          <ArchiveSearch active={destination === 'archive'} selection={navigation.remembered.archive} selectCapture={(captureId, revisionId) => navigation.navigate({ destination: 'archive', captureId, revisionId })} />
        </div>
        <div hidden={destination !== 'settings'} className="settings-workspace">
          <section aria-labelledby="capture-title">
            <h2 id="capture-title">ChatGPT integration</h2>
            <p className="status"><span className={`badge ${status?.enabled ? 'enabled' : ''}`}>ChatGPT: {status ? status.enabled ? 'Enabled' : 'Disabled' : 'Checking…'}</span></p>
            <p>Save selected excerpts or loaded conversations when you choose. Enabling grants access to chatgpt.com.</p>
            {status?.enabled
              ? <button className="secondary" onClick={() => void disable()} disabled={busy}>Disable ChatGPT and remove access</button>
              : <button onClick={() => void enable()} disabled={busy || !status}>Enable ChatGPT</button>}
            {notice && <p role={noticeError ? 'alert' : 'status'} className="feedback">{notice}</p>}
            <details><summary>How capture works</summary>
              <p><strong>Keep selection</strong> saves excerpts to Knowledge. <strong>Save loaded conversation</strong> reviews the loaded scope before saving to Archive. <strong>Preview selection</strong> saves nothing. Opening a page records nothing.</p>
              <p className="caption">Experimental selectors. Earlier history and other branches may be missing; response completion and temporary-mode detection can be unknown.</p>
            </details>
          </section>
          <BackupControls active={destination === 'settings'} />
          <LibraryCleanup />
          <section aria-labelledby="about-title"><h2 id="about-title">About and shortcuts</h2>
            <p className="caption">AI Knowledge Memory · Version {chrome.runtime.getManifest().version}</p>
            <dl className="shortcuts"><div><dt>Open recall</dt><dd><kbd>Alt+Shift+K</kbd></dd></div><div><dt>Preview selection</dt><dd><kbd>Alt+Shift+Y</kbd></dd></div></dl>
            <div className="actions"><button className="secondary" onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>Configure shortcuts</button>
              <button className="secondary" onClick={() => void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}>Chrome extension settings</button></div>
            <details><summary>Local storage and capture limits</summary>
              <p>Notes and history are unencrypted in this Chrome profile. Profile loss, uninstall, or browser reset can lose them. Keep a backup outside this profile.</p>
              <p>Shortcuts shown are defaults; Chrome may use your custom assignments. The optional Keep selected passage shortcut has no default. ChatGPT is supported; Gemini and Perplexity are planned.</p>
            </details>
          </section>
        </div>
        {notice && destination !== 'settings' && <p role={noticeError ? 'alert' : 'status'} className="feedback">{notice}</p>}
      </main>
    </div>
  </div>;
}
function LibraryGate() {
  const [ready, setReady] = useState(false), [notice, setNotice] = useState('Connecting to the local library…');
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, port: chrome.runtime.Port;
    const connect = () => {
      if (disposed) return;
      port = chrome.runtime.connect({ name: 'library-view' });
      port.onMessage.addListener(message => {
        if (disposed) return;
        if (message?.type === 'pause') {
          // Do not automatically reopen a stale detail after deletion/restore.
          history.replaceState(history.state, '', locationHref({ destination: readLocation(location.search).destination }));
          // Unmounting synchronously disposes workers, drafts, source/history
          // panels and in-flight readers before acknowledging the barrier.
          flushSync(() => { setReady(false); setNotice('Library maintenance is in progress. Open editors and search results have been cleared.'); });
          port.postMessage({ type: 'cleared', operationId: message.operationId });
        } else if (message?.type === 'ready') { setNotice(message.notice ?? ''); setReady(true); }
      });
      port.onDisconnect.addListener(() => {
        if (disposed) return;
        // Routine MV3 suspension must not discard an unsaved editor draft.
        // A pending deletion already unmounted it at the acknowledged barrier.
        setNotice('Reconnecting to the local library…'); timer = setTimeout(connect, 500);
      });
    };
    connect(); return () => { disposed = true; clearTimeout(timer); port?.disconnect(); };
  }, []);
  return <>{notice && <p role="status" className="gate-notice">{notice}</p>}{ready ? <App /> : <main className="app"><button onClick={() => {
    void chrome.runtime.sendMessage({ protocolVersion: 1, type: 'ResumeMaintenance' }).then(reply => { if (!reply?.ok) setNotice(reply?.message ?? 'Recovery is not finished. Retry or reload the extension.'); });
  }}>Resume interrupted deletion</button></main>}</>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><LibraryGate /></StrictMode>);
