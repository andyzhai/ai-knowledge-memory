import { CaptureError, eligibleSelection, freezeSelection, isExcludedContent, temporaryStatus, type FrozenSelection } from '../capture/selection';
import { canonicalRoute, type Reply } from '../shared/protocol';
import type { CurateSelection, CurationCommand, CurationReply, SelectionAction } from '../shared/curation';
import type { SaveResult } from '../shared/knowledge';
import { installLoadedControls } from './loaded-controls';
import { locateOriginal } from '../capture/locate';

const globals = globalThis as typeof globalThis & { __akmA0?: { dispose: () => void } };
if (!globals.__akmA0) install();

type Source = 'button' | 'context-menu' | 'keyboard';
type Boundary = { start: Node; startOffset: number; end: Node; endOffset: number };
type Attempt = {
  source: Source; epoch: number; boundary?: Boundary;
  result: { ok: true; snapshot: FrozenSelection } | { ok: false; code: string };
};

function boundary(selection: Selection | null): Boundary | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  return { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset };
}

function sameBoundary(a: Boundary, b: Boundary): boolean {
  return a.start === b.start && a.startOffset === b.startOffset && a.end === b.end && a.endOffset === b.endOffset;
}

function install(): void {
  let disposed = false;
  let route = canonicalRoute(location.href);
  let epoch = 0;
  let busy = false;
  let pending: Attempt | undefined;
  let allowanceEpoch: number | undefined;
  let keepIntent: { nonce: string; epoch: number; snapshot: FrozenSelection; requiresAllowance: boolean; command?: CurateSelection } | undefined;
  const host = document.createElement('div');
  host.id = 'akm-a0-probe';
  Object.assign(host.style, { position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647' });
  const shadow = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  button.textContent = 'Preview selection';
  button.hidden = true;
  Object.assign(button.style, { padding: '12px 16px', background: '#173b35', color: '#fff', border: '1px solid #fff', borderRadius: '8px', font: '14px system-ui', cursor: 'pointer' });
  const keepButton = button.cloneNode() as HTMLButtonElement;
  keepButton.textContent = 'Keep selection'; keepButton.hidden = true;
  const panel = document.createElement('section');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Selection preview');
  Object.assign(panel.style, { background: '#fff', color: '#172e2a', padding: '16px', border: '2px solid #173b35', borderRadius: '8px', maxWidth: 'min(440px, 85vw)', maxHeight: '65vh', overflow: 'auto', font: '14px system-ui' });
  shadow.append(keepButton, button, panel);
  document.documentElement.append(host);
  const disposeLoaded = installLoadedControls(shadow);

  function resetUi(): void { button.hidden = true; keepButton.hidden = true; panel.hidden = true; panel.replaceChildren(); }
  function clear(): void { pending = undefined; resetUi(); }
  function invalidateNavigation(): void {
    epoch++;
    allowanceEpoch = undefined; keepIntent = undefined;
    // Keep the reason for a click/menu callback already on its way, but release
    // all captured text and source-node references immediately.
    if (pending) pending = { ...pending, boundary: undefined, result: { ok: false, code: 'NAVIGATION_CHANGED' } };
    resetUi();
  }
  function checkRoute(): void {
    const next = canonicalRoute(location.href);
    if (next !== route) { route = next; invalidateNavigation(); }
  }
  // Browser Navigation API sees same-document history transitions, including a
  // rapid A → B → A that a later URL comparison alone would miss.
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  function onNavigation(): void { route = canonicalRoute(location.href); invalidateNavigation(); }
  function refresh(): void {
    checkRoute();
    if (disposed || !panel.hidden || pending?.source === 'button') return;
    // Focus can remain in the composer or on a toolbar after selecting response
    // text. Eligibility belongs to the selected nodes, not unrelated focus.
    button.hidden = !route || !eligibleSelection(window.getSelection());
    keepButton.hidden = button.hidden;
  }
  function freeze(source: Source, target?: EventTarget | null): Attempt {
    checkRoute();
    const selection = window.getSelection();
    const attempt = { source, epoch, boundary: boundary(selection) };
    try {
      if (target instanceof Node && isExcludedContent(target)) throw new CaptureError('EXCLUDED_CONTENT');
      pending = { ...attempt, result: { ok: true, snapshot: freezeSelection(selection, location.href) } };
    } catch (error) {
      pending = { ...attempt, result: { ok: false, code: error instanceof CaptureError ? error.code : 'PROBE_UNAVAILABLE' } };
    }
    return pending;
  }
  function showError(code: string): void {
    if (disposed) {
      const fallback = () => showText('Preview unavailable: PERMISSION_DENIED. Nothing was saved. Reload the extension and source tab.');
      try {
        void chrome.runtime.sendMessage({ protocolVersion: 1, type: 'OpenPreviewDiagnostic', code: 'PERMISSION_DENIED' })
          .then((reply: Reply) => { if (!reply?.ok) fallback(); }, fallback);
      } catch { fallback(); }
      return;
    }
    showText(`Preview unavailable: ${code}. Nothing was saved. Use copy/manual paste if this layout is unsupported.`);
  }
  function showText(message: string, snapshot?: FrozenSelection): void {
    if (!host.isConnected) document.documentElement.append(host);
    button.hidden = true; keepButton.hidden = true;
    panel.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = 'A0 preview — not saved';
    const body = document.createElement('p');
    body.textContent = message;
    panel.append(title, body);
    if (snapshot) {
      const pre = document.createElement('pre');
      pre.textContent = snapshot.selectedText;
      Object.assign(pre.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '13px' });
      const details = document.createElement('p');
      details.textContent = `${snapshot.fragments.length} source fragment(s). Roles: ${snapshot.fragments.map(f => f.role).join(', ')}. History, completion, and temporary mode: unknown.`;
      panel.append(pre, details);
    }
    const close = document.createElement('button');
    close.textContent = 'Close preview';
    close.addEventListener('click', () => { clear(); refresh(); });
    panel.append(close);
    panel.hidden = false;
    close.focus();
  }
  async function preview(source: Source): Promise<void> {
    if (disposed) { showError('PERMISSION_DENIED'); return; }
    if (busy) { showError('PREVIEW_IN_PROGRESS'); return; }
    busy = true;
    try {
      const request = source === 'keyboard' ? freeze(source) : pending;
      pending = undefined; // Each explicit action is consumed once.
      if (!request || request.source !== source) throw new CaptureError('NO_FROZEN_SELECTION');
      if (request.epoch !== epoch) throw new CaptureError('NAVIGATION_CHANGED');
      if (!request.result.ok) throw new CaptureError(request.result.code);
      const snapshot = request.result.snapshot;
      showText('Checking preview permission…');
      const reply = await authorize(snapshot.sourceUrl);
      checkRoute();
      if (disposed) throw new CaptureError('PERMISSION_DENIED');
      if (request.epoch !== epoch || snapshot.sourceUrl !== route) throw new CaptureError('NAVIGATION_CHANGED');
      if (!reply?.ok) throw new CaptureError(reply && !reply.ok ? reply.code : 'PROBE_UNAVAILABLE');
      showText('This is an in-memory capture feasibility check. Selectors and text conversion are experimental.', snapshot);
      action('Review or replace before keeping', () => reviewBeforeKeeping(snapshot));
    } catch (error) { showError(error instanceof CaptureError ? error.code : 'PROBE_UNAVAILABLE'); }
    finally { busy = false; }
  }
  async function authorize(sourceUrl: string): Promise<Reply> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage({ protocolVersion: 1, type: 'AuthorizePreview', route: sourceUrl }) as Promise<Reply>,
        new Promise<Reply>((_, reject) => { timer = setTimeout(() => reject(new CaptureError('AUTHORIZATION_TIMEOUT')), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function sendCuration(command: CurationCommand): Promise<CurationReply> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage(command) as Promise<CurationReply>,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CaptureError('WRITE_UNCONFIRMED')), 10_000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  function keepMessage(text: string, snapshot?: FrozenSelection): void {
    showText(text, snapshot);
    panel.querySelector('strong')!.textContent = 'Knowledge selection';
  }
  function action(label: string, run: () => void): void {
    const control = document.createElement('button'); control.textContent = label;
    control.addEventListener('click', event => { if (event.isTrusted && !busy) run(); }); panel.append(control);
  }
  function reviewBeforeKeeping(snapshot: FrozenSelection) {
    const reviewEpoch = epoch;
    keepMessage('Edit or exclude fragments before retaining them. Use placeholders for secrets; this is not a password vault. Existing library copies are not removed by this action.');
    const editors = snapshot.fragments.map((fragment, index) => {
      const label = document.createElement('label'), include = document.createElement('input'); include.type = 'checkbox'; include.checked = true;
      label.append(include, ` Include fragment ${index + 1}`);
      const editor = document.createElement('textarea'); editor.value = fragment.exactText; editor.setAttribute('aria-label', `Fragment ${index + 1} before saving`);
      editor.rows = 5; editor.style.width = '100%';
      const placeholder = document.createElement('input'); placeholder.value = '[API_KEY]'; placeholder.maxLength = 100; placeholder.setAttribute('aria-label', `Placeholder for fragment ${index + 1}`);
      panel.append(label, editor, placeholder);
      action(`Replace selected text in fragment ${index + 1}`, () => {
        if (editor.selectionStart !== editor.selectionEnd) editor.setRangeText(placeholder.value, editor.selectionStart, editor.selectionEnd, 'select');
      });
      return { fragment, include, editor };
    });
    action('Save reviewed fragments', () => {
      checkRoute();
      if (reviewEpoch !== epoch || route !== snapshot.sourceUrl) { showError('NAVIGATION_CHANGED'); return; }
      const kept = editors.filter(e => e.include.checked && e.editor.value.trim());
      if (!kept.length) { keepMessage('No fragments retained. Nothing was submitted.'); return; }
      const changed = kept.length !== editors.length || kept.some(e => e.editor.value !== e.fragment.exactText);
      const reviewed: FrozenSelection = changed ? { ...snapshot,
        selectedText: kept.map(e => e.editor.value).join('\n\n'),
        fragments: kept.map(e => ({ ...e.fragment, exactText: e.editor.value, sourceMessageId: null, startCodePoint: 0, endCodePoint: Array.from(e.editor.value).length })),
        warnings: [...new Set([...snapshot.warnings, 'source_text_replaced_before_save', 'original_identity_unavailable'])],
      } : snapshot;
      keepIntent = { nonce: crypto.randomUUID(), epoch, snapshot: reviewed, requiresAllowance: reviewed.temporaryStatus === 'temporary' };
      void saveFrozen();
    });
  }
  function showSaved(result: SaveResult, command: CurateSelection): void {
    keepMessage(result.created ? 'Saved to Knowledge. Saved does not mean endorsed.' : 'Already saved. Your existing note was kept unchanged.');
    const savedRequestId = command.requestId;
    action('Open local source', () => { void sendCuration({ protocolVersion: 1, type: 'OpenSelection', generation: command.generation, savedRequestId }).then(reply => {
      if (!reply.ok) keepMessage(`Could not open local source: ${reply.code}. Open the library from the toolbar.`);
    }).catch(() => keepMessage('Could not open local source. Open the library from the toolbar.')); });
    const perform = (type: SelectionAction['type']) => {
      const request: SelectionAction = { protocolVersion: 1, type, generation: command.generation, savedRequestId,
        expectedRecordVersion: result.recordVersion, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString() };
      const run = async () => {
        busy = true;
        try {
          const reply = await sendCuration(request);
          if (!reply.ok) throw new CaptureError(reply.code);
          if ('result' in reply) {
            keepMessage(type === 'UndoSelection' ? `Undone. ${(reply.result.retainedSources ?? 0) > 0 ? 'Shared or independently retained sources remain in the library.' : 'The new note and its exclusive excerpts were removed.'}` : 'Endorsed. Your approval is recorded in saved history.');
          }
        } catch (error) {
          keepMessage(`Action not confirmed: ${error instanceof CaptureError ? error.code : 'WRITE_UNCONFIRMED'}. Check the library or retry the same action.`);
          action('Retry action', () => void run());
        } finally { busy = false; }
      };
      void run();
    };
    if (result.created) action('Endorse', () => perform('EndorseSelection'));
    if (result.created) action('Undo new selection', () => perform('UndoSelection'));
  }
  async function saveFrozen(): Promise<void> {
    const current = keepIntent;
    if (!current || busy) return;
    busy = true;
    try {
      checkRoute();
      if (disposed || current.epoch !== epoch) throw new CaptureError('NAVIGATION_CHANGED');
      keepMessage('Saving selection…');
      if (!current.command) {
        const begin = await sendCuration({ protocolVersion: 1, type: 'BeginSelection', route: current.snapshot.sourceUrl, nonce: current.nonce });
        if (!begin.ok) throw new CaptureError(begin.code);
        if (!('generation' in begin) || !('providerEpoch' in begin)) throw new CaptureError('WRITE_UNCONFIRMED');
        current.command = { protocolVersion: 1, type: 'CurateSelection', requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(),
          generation: begin.generation, providerEpoch: begin.providerEpoch, nonce: current.nonce, snapshot: current.snapshot };
      }
      if (disposed || current.epoch !== epoch) throw new CaptureError('NAVIGATION_CHANGED');
      let reply = await sendCuration(current.command);
      for (let attempt = 0; !reply.ok && reply.retryable && attempt < 2; attempt++) reply = await sendCuration(current.command);
      checkRoute();
      if (disposed || current.epoch !== epoch) throw new CaptureError('NAVIGATION_CHANGED');
      if (!reply.ok) throw new CaptureError(reply.code);
      if (!('result' in reply)) throw new CaptureError('WRITE_UNCONFIRMED');
      showSaved(reply.result, current.command);
    } catch (error) {
      const code = error instanceof CaptureError ? error.code : 'WRITE_UNCONFIRMED';
      const stillHere = !disposed && current.epoch === epoch;
      keepMessage(`Selection save unavailable: ${code}. ${current.command ? 'If a reply was lost, check the library or retry this same save.' : 'No save was submitted.'}`, stillHere ? current.snapshot : undefined);
      if (stillHere && code === 'TEMPORARY_ALLOW_REQUIRED') {
        const explanation = document.createElement('p'); explanation.textContent = 'Saving creates a local copy even though this conversation is temporary. Allowance ends when you leave this conversation.'; panel.append(explanation);
        action('Allow saving this conversation', () => { allowanceEpoch = epoch; void saveFrozen(); });
      } else if (stillHere) action('Retry same selection', () => void saveFrozen());
    } finally { busy = false; }
  }
  async function keep(source: Source): Promise<void> {
    if (busy) { keepMessage('Another action is still running. Wait for its result.'); return; }
    const request = source === 'keyboard' ? freeze(source) : pending;
    pending = undefined;
    if (!request || request.source !== source || request.epoch !== epoch || !request.result.ok) {
      keepMessage(`Selection save unavailable: ${request && !request.result.ok ? request.result.code : 'NO_FROZEN_SELECTION'}. Nothing was submitted; use copy/manual paste for unsupported layouts.`); return;
    }
    keepIntent = { nonce: crypto.randomUUID(), epoch, snapshot: request.result.snapshot, requiresAllowance: request.result.snapshot.temporaryStatus === 'temporary' };
    await saveFrozen();
  }
  keepButton.addEventListener('pointerdown', event => {
    if (event.isTrusted && event.button === 0) { freeze('button'); event.preventDefault(); }
  });
  keepButton.addEventListener('keydown', event => { if (event.isTrusted && (event.key === 'Enter' || event.key === ' ')) freeze('button'); });
  keepButton.addEventListener('click', event => { if (event.isTrusted) void keep('button'); });
  button.addEventListener('pointerdown', event => {
    if (!event.isTrusted || event.button !== 0) return;
    freeze('button');
    event.preventDefault(); // Keep the selection until its immutable snapshot exists.
  });
  button.addEventListener('click', event => { if (event.isTrusted) void preview('button'); });
  button.addEventListener('keydown', event => {
    if (event.isTrusted && (event.key === 'Enter' || event.key === ' ')) {
      freeze('button');
    }
  });
  const onContextMenu = (event: Event) => {
    if (!event.isTrusted) return;
    checkRoute();
    // Secondary pointerdown / the menu key can precede a focus-induced collapse.
    // Reuse only that action's snapshot; a noncollapsed selection at contextmenu
    // is authoritative (right-click may have selected a different word).
    if (!pending || pending.source !== 'context-menu' || boundary(window.getSelection()) ||
        (event.target instanceof Node && isExcludedContent(event.target))) freeze('context-menu', event.target);
  };
  const onSelection = () => {
    const current = boundary(window.getSelection());
    // Notifications are queued and do not imply a new user intent. Preserve an
    // action across same-range notifications and menu/button focus collapse.
    // A genuinely different nonempty range must never reuse the old source.
    if (pending?.result.ok && pending.boundary && current && !sameBoundary(pending.boundary, current)) {
      pending = { ...pending, boundary: undefined, result: { ok: false, code: 'SELECTION_CHANGED' } };
    }
    refresh();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isTrusted || event.composedPath().includes(host)) return;
    if (event.button !== 2) return;
    pending = undefined; // A new context-menu gesture replaces the old one.
    const selection = window.getSelection();
    if (!boundary(selection)) return;
    const inside = Array.from(selection!.getRangeAt(0).getClientRects()).some(rect =>
      event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    if (inside) freeze('context-menu', event.target);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.composedPath().includes(host)) return;
    if (event.key === 'Escape') pending = undefined;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) freeze('context-menu', event.target);
  };
  const onMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (reply: Reply) => void) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
    if ('type' in message && message.type === 'ClearPendingCaptures') {
      const hadFeedback = !panel.hidden || !!keepIntent || !!pending;
      epoch++; keepIntent = undefined; allowanceEpoch = undefined; clear();
      if (hadFeedback) keepMessage('Pending selections cleared for library deletion. No source text is retained in this panel.');
      sendResponse({ ok: true }); return;
    }
    const type = (message as { type?: unknown }).type;
    if (type === 'LocateOriginalSource') {
      const request = message as { route: string; anchor: import('../shared/archive').SourceRef['originalPageAnchor'] };
      try { (sendResponse as (reply: unknown) => void)({ ok: true, location: locateOriginal(request.route, request.anchor) }); }
      catch { (sendResponse as (reply: unknown) => void)({ ok: true, location: 'unavailable' }); }
    }
    if (type === 'ValidateSelectionIntent') {
      checkRoute();
      const value = message as { nonce?: string; route?: string };
      const same = !disposed && keepIntent?.nonce === value.nonce && keepIntent?.epoch === epoch && route === value.route;
      if (keepIntent && temporaryStatus() === 'temporary') keepIntent.requiresAllowance = true;
      const temporary = keepIntent?.requiresAllowance === true;
      sendResponse(same && (!temporary || allowanceEpoch === epoch) ? { ok: true } : { ok: false, code: same ? 'TEMPORARY_ALLOW_REQUIRED' : 'NAVIGATION_CHANGED' });
    }
    if (type === 'DisposeProbe') dispose();
    if (type === 'PreviewSelection' || type === 'KeepSelection') {
      const source = (message as { source?: unknown }).source;
      if (source === 'keyboard' || source === 'context-menu') {
        if (type === 'KeepSelection') void keep(source); else void preview(source);
        sendResponse({ ok: true }); // Receipt, not capture success. The page owns feedback.
      }
    }
  };
  const observer = new MutationObserver(checkRoute); // Route check only; never accumulates messages.
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Capture at window before provider document handlers can stop propagation.
  window.addEventListener('selectionchange', onSelection, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('pointerup', refresh, true);
  window.addEventListener('keyup', refresh, true);
  window.addEventListener('popstate', checkRoute);
  navigation?.addEventListener('currententrychange', onNavigation);
  chrome.runtime.onMessage.addListener(onMessage);
  function dispose(): void {
    disposeLoaded();
    disposed = true; epoch++; keepIntent = undefined; allowanceEpoch = undefined; clear(); observer.disconnect();
    window.removeEventListener('selectionchange', onSelection, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pointerup', refresh, true);
    window.removeEventListener('keyup', refresh, true);
    window.removeEventListener('popstate', checkRoute);
    navigation?.removeEventListener('currententrychange', onNavigation);
    chrome.runtime.onMessage.removeListener(onMessage);
    host.remove(); delete globals.__akmA0;
  }
  globals.__akmA0 = { dispose };
  refresh();
}
