import { CHATGPT_MATCH, CHATGPT_ORIGIN, CONTENT_SCRIPT_ID, canonicalRoute, parseCommand, type Reply, type Status } from '../shared/protocol';
import { parseLibraryCommand, libraryError, KnowledgeError, type LibraryReply } from '../shared/knowledge';
import { activeRepository } from '../storage/repository';
import { parseCurationCommand, type CurationReply, type SourceBinding, type CurationOwner } from '../shared/curation';
import { prepareSelection, curate, selectionReceipt, actOnSelection, identifyCaller } from '../storage/curation';
import { canonicalJson, fail, exactKeys, isId, RETRY_HORIZON_MS } from '../shared/knowledge';
import { parseSearchReadCommand, type SearchReadReply } from '../shared/search-access';
import { readSearch } from '../storage/search';
import { parseCaptureCommand, parseArchiveRead, parseArchiveOpen, type CaptureReply, type ArchiveReply } from '../shared/loaded-capture';
import { prepareCapture, commitCapture, interruptOrphan, readArchive } from '../storage/loaded-capture';
import { parseManagement, type ManagementReply } from '../shared/management';
import { manageNote } from '../storage/management';
import { beginDeletion, previewDeletion, resumeDeletion } from '../storage/deletion';
import { clearDerivedCaches, resetLibrary, resetReceipt } from '../storage/reset';
import { pauseViews, registerViews, resumeViews } from './views';
import { handleBackup, isBackupRequest, clearBackupTransfers, type BackupReply } from './backup-service';
import { recoverRestore } from '../storage/backup';

const SETTING = 'chatgptProbeEnabled';
const MENU = 'akm-preview-selection';
const KEEP_MENU = 'akm-keep-selection';
const PROVIDER_EPOCH = 'chatgptProviderEpoch';
let accessRevision = 0;
let queue = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function status(): Promise<Status> {
  const [settings, granted, scripts] = await Promise.all([
    chrome.storage.local.get(SETTING),
    chrome.permissions.contains({ origins: [CHATGPT_MATCH] }),
    chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] }),
  ]);
  return { enabled: settings[SETTING] === true && granted, granted, registered: scripts.length > 0, milestone: 'A6' };
}

async function reconcile(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const current = await status();
  if (current.enabled && !current.registered) {
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID, matches: [CHATGPT_MATCH], js: ['content.js'],
      runAt: 'document_idle', allFrames: false, world: 'ISOLATED', persistAcrossSessions: true,
    }]);
  } else if (!current.enabled && current.registered) {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  }
  if (!current.granted) await chrome.storage.local.set({ [SETTING]: false });
  // Revocation may hide tab URLs, so signal all tabs; only our existing scripts listen.
  const tabs = await chrome.tabs.query(current.enabled ? { url: [CHATGPT_MATCH] } : {});
  await Promise.all(tabs.map(async tab => {
    if (tab.id === undefined) return;
    try {
      if (current.enabled) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'] });
      } else await chrome.tabs.sendMessage(tab.id, { type: 'DisposeProbe' }, { frameId: 0 });
    } catch { /* A tab may navigate/close, or have no injected script. */ }
  }));
}

function isUi(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url || sender.frameId && sender.frameId !== 0) return false;
  const url = new URL(sender.url);
  return url.protocol === 'chrome-extension:' && url.host === chrome.runtime.id &&
    ['/library.html', '/sidepanel.html'].includes(url.pathname);
}

export type SenderCheckFailure = 'sender_id_mismatch' | 'non_zero_frame' | 'no_document_id' | 'no_tab_id' | 'incognito' | 'cross_origin';

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

export function senderCheckFailure(sender: chrome.runtime.MessageSender, extensionId: string): SenderCheckFailure | null {
  if (sender.id !== extensionId) return 'sender_id_mismatch';
  if (sender.frameId !== undefined && sender.frameId !== 0) return 'non_zero_frame';
  if (!sender.documentId) return 'no_document_id';
  if (sender.tab?.id === undefined) return 'no_tab_id';
  if (sender.tab?.incognito) return 'incognito';
  if (originOf(sender.url) !== CHATGPT_ORIGIN) return 'cross_origin';
  return null;
}

async function sourceBinding(sender: chrome.runtime.MessageSender, route: string, nonce: string): Promise<SourceBinding> {
  if (sender.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0) || !sender.documentId ||
      sender.tab?.id === undefined || sender.tab.incognito || originOf(sender.url) !== CHATGPT_ORIGIN) {
    console.warn('[akm] sourceBinding sender rejected', senderCheckFailure(sender, chrome.runtime.id), { frameId: sender.frameId, hasDocumentId: !!sender.documentId, hasTabId: sender.tab?.id !== undefined });
    fail('UNAUTHORIZED_CONTEXT');
  }
  if (!(await status()).enabled) fail('PERMISSION_DENIED');
  const tab = await chrome.tabs.get(sender.tab.id);
  if (canonicalRoute(tab.url ?? '') !== route || (tab.pendingUrl && canonicalRoute(tab.pendingUrl) !== route)) fail('NAVIGATION_CHANGED');
  return { tabId: sender.tab.id, documentId: sender.documentId, route, nonce };
}
async function checkIntent(binding: SourceBinding, loaded = false): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(binding.tabId, { type: loaded ? 'ValidateLoadedIntent' : 'ValidateSelectionIntent', nonce: binding.nonce, route: binding.route }, { documentId: binding.documentId }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new KnowledgeError('NAVIGATION_CHANGED')), 5000); }),
    ]);
    if (!response?.ok) fail(response?.code === 'TEMPORARY_ALLOW_REQUIRED' ? 'TEMPORARY_ALLOW_REQUIRED' : 'NAVIGATION_CHANGED');
  } catch (error) { if (error instanceof KnowledgeError) throw error; fail('NAVIGATION_CHANGED'); }
  finally { clearTimeout(timer); }
}
async function providerEpoch(): Promise<string> {
  const settings = await chrome.storage.local.get(PROVIDER_EPOCH);
  if (typeof settings[PROVIDER_EPOCH] === 'string') return settings[PROVIDER_EPOCH];
  const epoch = crypto.randomUUID(); await chrome.storage.local.set({ [PROVIDER_EPOCH]: epoch }); return epoch;
}

async function recoverCaptures(): Promise<void> {
  const repo = await activeRepository();
  const sessions = await repo.db.captures.filter(c => c.scope === 'loaded_conversation' && c.captureStatus === 'in_progress').toArray();
  for (const capture of sessions) {
    try {
      if (!capture.owner || !(await status()).enabled || capture.providerEpoch !== await providerEpoch()) fail('PROVIDER_STATE_CHANGED');
      if (!capture.issuedAt || Date.now() - Date.parse(capture.issuedAt) >= RETRY_HORIZON_MS) fail('INTENT_EXPIRED');
      const conversation = await repo.db.conversations.get(capture.conversationId);
      const route = conversation?.canonicalUrl;
      const tab = await chrome.tabs.get(capture.owner.tabId);
      if (!route || canonicalRoute(tab.url ?? '') !== route || (tab.pendingUrl && canonicalRoute(tab.pendingUrl) !== route)) fail('NAVIGATION_CHANGED');
      await checkIntent({ ...capture.owner, route }, true);
    } catch {
      await interruptOrphan(repo, capture.id, 'source_session_unavailable');
      const meta = await repo.checkReady();
      void chrome.runtime.sendMessage({ type: 'KnowledgeChanged', generation: repo.generation, dataSeq: meta.dataSeq }).catch(() => undefined);
    }
  }
}
async function cancelCaptures() {
  clearBackupTransfers();
  ++accessRevision;
  await chrome.storage.local.set({ [PROVIDER_EPOCH]: crypto.randomUUID() });
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (tab.id !== undefined) await chrome.tabs.sendMessage(tab.id, { type: 'ClearPendingCaptures' }, { frameId: 0 }).catch(() => undefined);
  }));
}
async function recoverDeletion() {
  const reset = await chrome.storage.local.get('resetOperation');
  if (reset.resetOperation) { await pauseViews('reset'); await resetLibrary(); await reconcile(); resumeViews('All local data removed. ChatGPT capture is off until you enable it again.'); return; }
  const restoreNotice = await recoverRestore();
  if (restoreNotice) { await reconcile(); resumeViews(restoreNotice); }
  const repo = await activeRepository(), meta = await repo.db.meta.get('library');
  if (!meta?.deletion) return;
  await pauseViews(meta.deletion.command.requestId); await cancelCaptures();
  if (meta.deletion.command.target.kind === 'all') { await resetLibrary(meta.deletion.command); await reconcile(); }
  else { await resumeDeletion(repo); await clearDerivedCaches(); }
  resumeViews('Deletion completed. Local views have been refreshed.');
}
async function handle(value: unknown, sender: chrome.runtime.MessageSender): Promise<Reply | LibraryReply | CurationReply | SearchReadReply | CaptureReply | ArchiveReply | ManagementReply | BackupReply | { ok: true; location: string }> {
  await initialized;
  if (isBackupRequest(value)) {
    if (!isUi(sender) || !sender.documentId) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
    try { return await serialize(() => handleBackup(value, sender.documentId!, { cancelCaptures, reconcile })); }
    catch (error) { return libraryError(error); }
  }
  if (exactKeys(value, ['protocolVersion', 'type']) && value.protocolVersion === 1 && value.type === 'ResumeMaintenance') {
    if (!isUi(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
    try { await serialize(recoverDeletion); return { ok: true }; } catch (error) { return libraryError(error); }
  }
  const management = parseManagement(value);
  if (management) {
    if (!isUi(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
    try {
      return await serialize(async () => {
        if (management.type === 'DeleteLibraryData' && management.target.kind === 'all') {
          const receipt = await resetReceipt(management); if (receipt) return { ok: true as const, result: receipt };
        }
        const repo = await activeRepository();
        if (management.generation !== repo.generation) fail('GENERATION_CHANGED');
        if (management.type === 'PreviewDeletion') return { ok: true as const, preview: await previewDeletion(repo, management.target) };
        if (management.type !== 'DeleteLibraryData') return { ok: true as const, result: await manageNote(repo, management) };
        // Clear and terminate each connected view before admitting deletion.
        // A durable fence then hides all reads until every batch has committed.
        try {
          await pauseViews(management.requestId); await cancelCaptures();
          const prior = await beginDeletion(repo, management);
          const result = management.target.kind === 'all' ? await resetLibrary(management) : prior ?? await resumeDeletion(repo);
          await clearDerivedCaches();
          if (management.target.kind === 'all') await reconcile();
          if (!result) fail('WRITE_FAILED');
          resumeViews(management.target.kind === 'all' ? 'All local data removed. ChatGPT capture is off until you enable it again.' : 'Deletion completed. Shared or independently retained Archive content remains.');
          return { ok: true as const, result };
        } catch (error) {
          // Keep the UI fenced on interrupted work. Recovery is an explicit
          // action and also runs at worker startup, before admitting readers.
          if (!(await repo.db.meta.get('library').catch(() => undefined))?.deletion && !(await chrome.storage.local.get('resetOperation')).resetOperation) resumeViews(libraryError(error).message);
          throw error;
        }
      });
    } catch (error) { return libraryError(error); }
  }
  if (exactKeys(value, ['protocolVersion', 'type', 'generation', 'sourceId']) && value.protocolVersion === 1 && value.type === 'VerifyOriginalSource' && isId(value.generation) && isId(value.sourceId)) {
    try {
      if (!isUi(sender)) fail('UNAUTHORIZED_CONTEXT');
      const repo = await activeRepository(); await repo.checkReady();
      if (repo.generation !== value.generation) fail('GENERATION_CHANGED');
      const source = await repo.db.sourceRefs.get(value.sourceId);
      if (!source) fail('NOT_FOUND');
      if (!(await status()).enabled || !source.sourceUrl || !source.originalPageAnchor || source.sourceRemovedAt) return { ok: true, location: 'unavailable' };
      const tabs = (await chrome.tabs.query({ url: [CHATGPT_MATCH] })).filter(tab => canonicalRoute(tab.url ?? '') === source.sourceUrl && !tab.incognito);
      if (tabs.length !== 1 || tabs[0]?.id === undefined) return { ok: true, location: tabs.length ? 'ambiguous' : 'unavailable' };
      const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'LocateOriginalSource', route: source.sourceUrl, anchor: source.originalPageAnchor }, { frameId: 0 });
      const location = ['verified', 'ambiguous', 'missing', 'changed'].includes(result?.location) ? result.location : 'unavailable';
      return { ok: true, location };
    } catch (error) { return libraryError(error); }
  }
  const captureCommand = parseCaptureCommand(value);
  if (captureCommand) {
    try {
      const admitted = accessRevision;
      const binding = await sourceBinding(sender, captureCommand.route, captureCommand.nonce);
      await checkIntent(binding, true);
      if (captureCommand.type === 'BeginLoadedCapture') return { ok: true, generation: (await activeRepository()).generation, providerEpoch: await providerEpoch() };
      if (await providerEpoch() !== captureCommand.providerEpoch) fail('PROVIDER_STATE_CHANGED');
      const prepared = await prepareCapture(captureCommand, binding);
      return await serialize(async () => {
        await sourceBinding(sender, binding.route, binding.nonce);
        if (await providerEpoch() !== captureCommand.providerEpoch || admitted !== accessRevision) fail('PROVIDER_STATE_CHANGED');
        await checkIntent(binding, true);
        return { ok: true as const, progress: await commitCapture(await activeRepository(), prepared) };
      });
    } catch (error) { return libraryError(error); }
  }
  const openArchive = parseArchiveOpen(value);
  if (openArchive) {
    try {
      return await serialize(async () => {
        const repo = await activeRepository(); await repo.checkReady();
        if (repo.generation !== openArchive.generation) fail('GENERATION_CHANGED');
        const capture = await repo.db.captures.get(openArchive.captureId);
        if (!capture) fail('NOT_FOUND');
        if (!isUi(sender)) {
          if (!capture.owner) fail('UNAUTHORIZED_CONTEXT');
          if (sender.tab?.id === undefined) fail('UNAUTHORIZED_CONTEXT');
          const tab = await chrome.tabs.get(sender.tab.id);
          const route = canonicalRoute(tab.url ?? '');
          if (!route) fail('UNAUTHORIZED_CONTEXT');
          const caller = await identifyCaller(await sourceBinding(sender, route, capture.owner.nonce));
          if (canonicalJson(caller) !== canonicalJson(capture.owner)) fail('UNAUTHORIZED_CONTEXT');
        }
        if (capture.captureStatus !== 'completed') fail('CAPTURE_INCOMPLETE');
        // Web-origin links cannot navigate to private extension pages. Keep the
        // library private and open only this persisted result from our worker.
        await chrome.tabs.create({ url: chrome.runtime.getURL(`library.html?capture=${capture.id}`) });
        return { ok: true as const };
      });
    } catch (error) { return libraryError(error); }
  }
  const archiveCommand = parseArchiveRead(value);
  if (archiveCommand) {
    if (!isUi(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT', message: 'Archive requires an extension view.', retryable: false };
    try { return await serialize(async () => { await recoverCaptures(); return readArchive(await activeRepository(), archiveCommand); }); }
    catch (error) { return libraryError(error); }
  }
  const curationCommand = parseCurationCommand(value);
  if (curationCommand) {
    try {
      if (curationCommand.type === 'CurateSelection') {
        const admittedRevision = accessRevision;
        const binding = await sourceBinding(sender, curationCommand.snapshot.sourceUrl, curationCommand.nonce);
        if (await providerEpoch() !== curationCommand.providerEpoch) fail('PROVIDER_STATE_CHANGED');
        await checkIntent(binding);
        const prepared = await prepareSelection(curationCommand, binding);
        // Preparation does not hold the settings queue. Disable/revoke can
        // invalidate a pending capture while hashes are being computed.
        return await serialize(async () => {
          await sourceBinding(sender, binding.route, binding.nonce);
          if (await providerEpoch() !== curationCommand.providerEpoch) fail('PROVIDER_STATE_CHANGED');
          await checkIntent(binding);
          if (admittedRevision !== accessRevision) fail('PROVIDER_STATE_CHANGED');
          return { ok: true as const, result: await curate(await activeRepository(), prepared) };
        });
      }
      return await serialize(async () => {
        if (curationCommand.type === 'BeginSelection') {
          const binding = await sourceBinding(sender, curationCommand.route, curationCommand.nonce);
          await checkIntent(binding);
          return { ok: true as const, generation: (await activeRepository()).generation, providerEpoch: await providerEpoch() };
        }
        const repo = await activeRepository();
        let caller: CurationOwner | undefined;
        if (!isUi(sender)) {
          const receipt = await repo.db.requestReceipts.get(curationCommand.savedRequestId);
          if (!receipt?.caller || sender.tab?.id === undefined) fail('UNAUTHORIZED_CONTEXT');
          const tab = await chrome.tabs.get(sender.tab.id);
          const route = canonicalRoute(tab.url ?? '');
          if (!route) fail('UNAUTHORIZED_CONTEXT');
          caller = await identifyCaller(await sourceBinding(sender, route, receipt.caller.nonce));
        }
        const receipt = await selectionReceipt(repo, curationCommand.generation, curationCommand.savedRequestId, caller);
        if (curationCommand.type === 'OpenSelection') {
          if (receipt.invalidated) fail('RESULT_REMOVED');
          await chrome.tabs.create({ url: chrome.runtime.getURL(`library.html?note=${receipt.result.knowledgeId}`) });
          return { ok: true as const };
        }
        if (curationCommand.type === 'UndoSelection') {
          try {
            await pauseViews(curationCommand.requestId); await cancelCaptures();
            const result = await actOnSelection(repo, curationCommand, caller);
            await clearDerivedCaches(); resumeViews('Undone. Shared or independently retained sources remain.');
            return { ok: true as const, result };
          } catch (error) { resumeViews(libraryError(error).message); throw error; }
        }
        return { ok: true as const, result: await actOnSelection(repo, curationCommand, caller) };
      });
    } catch (error) { return libraryError(error); }
  }
  const searchCommand = parseSearchReadCommand(value);
  if (searchCommand) {
    if (!isUi(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
    try { return await readSearch(await activeRepository(), searchCommand); }
    catch (error) { return libraryError(error); }
  }
  const libraryCommand = parseLibraryCommand(value);
  if (libraryCommand) {
    if (!isUi(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
    try { return await serialize(async () => (await activeRepository()).execute(libraryCommand)); }
    catch (error) { return libraryError(error); }
  }
  const command = parseCommand(value);
  if (!command) return libraryError(new KnowledgeError('INVALID_COMMAND'));
  if (command.type === 'OpenPreviewDiagnostic') {
    // An in-flight page preview may be disposed during permission revocation.
    // Only our top-frame ChatGPT script may request this fixed, content-free UI.
    // Origin-only check: the route is not compared here, as sender.url may be
    // stale after same-document SPA navigation (tab URL is not needed for this).
    if (sender.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0) || !sender.documentId || sender.tab?.id === undefined ||
        originOf(sender.url) !== CHATGPT_ORIGIN) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
    await openPreviewDiagnostic(command.code);
    return { ok: true };
  }
  if (command.type === 'AuthorizePreview') {
    const route = canonicalRoute(command.route);
    if (sender.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0) || !sender.documentId ||
        sender.tab?.id === undefined || !route || originOf(sender.url) !== CHATGPT_ORIGIN) {
      return { ok: false, code: 'UNSUPPORTED_PAGE' };
    }
    const tab = await chrome.tabs.get(sender.tab.id);
    if (canonicalRoute(tab.url ?? '') !== route || (tab.pendingUrl && canonicalRoute(tab.pendingUrl) !== route)) return { ok: false, code: 'NAVIGATION_CHANGED' };
    return (await status()).enabled ? { ok: true } : { ok: false, code: 'PERMISSION_DENIED' };
  }
  if (!isUi(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
  if (command.type === 'SetProviderEnabled') {
    ++accessRevision; // Invalidate pending admissions before queued settings I/O.
    return serialize(async () => {
      if (command.enabled && !await chrome.permissions.contains({ origins: [CHATGPT_MATCH] })) return { ok: false, code: 'PERMISSION_DENIED' };
      await chrome.storage.local.set({ [SETTING]: command.enabled, [PROVIDER_EPOCH]: crypto.randomUUID() });
      await reconcile();
      return { ok: true, status: await status() };
    });
  }
  return { ok: true, status: await status() };
}

// Register synchronously. Provider preview text stays on its source page.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handle(message, sender).then(reply => {
    // A hint sent only after commit; readers also reconcile on open/focus and
    // hydrate against the canonical sequence before publishing search results.
    if (reply.ok && 'result' in reply) {
      void chrome.runtime.sendMessage({ type: 'KnowledgeChanged', generation: reply.result.generation, dataSeq: reply.result.dataSeq }).catch(() => undefined);
    }
    if (reply.ok && 'progress' in reply) void chrome.runtime.sendMessage({ type: 'KnowledgeChanged', generation: reply.progress.generation, dataSeq: reply.progress.dataSeq }).catch(() => undefined);
    sendResponse(reply);
  }, () => sendResponse({ ok: false, code: 'PROBE_UNAVAILABLE' }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
    id: MENU, title: 'Preview selection (not saved)', contexts: ['selection'], documentUrlPatterns: [CHATGPT_MATCH],
    });
    chrome.contextMenus.create({ id: KEEP_MENU, title: 'Keep selection in Knowledge', contexts: ['selection'], documentUrlPatterns: [CHATGPT_MATCH] });
  });
});
chrome.permissions.onRemoved.addListener(() => { ++accessRevision; void serialize(async () => { await chrome.storage.local.set({ [PROVIDER_EPOCH]: crypto.randomUUID() }); await reconcile(); }).catch(() => undefined); });
chrome.permissions.onAdded.addListener(() => { void serialize(reconcile).catch(() => undefined); });
chrome.runtime.onStartup.addListener(() => { void serialize(reconcile).catch(() => undefined); });

async function openPreviewDiagnostic(code: string, keep = false): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`library.html?${keep ? 'saveError' : 'previewError'}=${encodeURIComponent(code)}`) });
}

function preview(tab: chrome.tabs.Tab | undefined, source: 'keyboard' | 'context-menu', keep = false): void {
  void (async () => {
    let code = 'PROBE_UNAVAILABLE';
    try {
      await initialized;
      if (tab?.id === undefined) code = 'SOURCE_TAB_UNAVAILABLE';
      else if (!(await status()).enabled) code = 'PERMISSION_DENIED';
      else {
        code = 'CONTENT_SCRIPT_UNAVAILABLE';
        const receipt = await chrome.tabs.sendMessage(tab.id, { type: keep ? 'KeepSelection' : 'PreviewSelection', source }, { frameId: 0 });
        if (receipt?.ok) return;
      }
    } catch { /* Show delivery/initialization failure in extension UI, never swallow it. */ }
    await openPreviewDiagnostic(code, keep);
  })().catch(() => {
    // If even the local diagnostic tab cannot open, leave a visible toolbar cue.
    void chrome.action.setBadgeText({ text: '!' });
    void chrome.action.setTitle({ title: 'Preview unavailable. Open the library and reload the source tab.' });
  });
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU) preview(tab, 'context-menu');
  if (info.menuItemId === KEEP_MENU) preview(tab, 'context-menu', true);
});
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-recall' && tab?.windowId !== undefined) {
    // Keep open() in the user-gesture call stack, before awaiting initialization.
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  } else if (command === 'preview-selection') preview(tab, 'keyboard');
  else if (command === 'keep-selection') preview(tab, 'keyboard', true);
});
const initialized = serialize(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await recoverDeletion().catch(async error => {
    if ((await chrome.storage.local.get('restoreOperation')).restoreOperation) resumeViews(libraryError(error).message);
  });
  await reconcile();
  // Recovery failure is surfaced by Archive reads. Provider controls and manual
  // note diagnostics must still initialize when storage itself is unavailable.
  await recoverCaptures().catch(() => undefined);
});
// Handler failures remain explicit; do not emit content-bearing exception logs.
void initialized.catch(() => undefined);
registerViews(isUi, () => initialized);
