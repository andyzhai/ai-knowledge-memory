import { CHATGPT_MATCH, parseCommand, type Reply } from '../shared/protocol';
import { parseLibraryCommand, libraryError, KnowledgeError, exactKeys, isId, type LibraryReply } from '../shared/knowledge';
import { activeRepository } from '../storage/repository';
import { parseCurationCommand, type CurationReply } from '../shared/curation';
import { parseSearchReadCommand, type SearchReadReply } from '../shared/search-access';
import { readSearch } from '../storage/search';
import { parseCaptureCommand, parseArchiveRead, parseArchiveOpen, type CaptureReply, type ArchiveReply } from '../shared/loaded-capture';
import { parseManagement, type ManagementReply } from '../shared/management';
import { registerViews, resumeViews } from './views';
import { handleBackup, isBackupRequest, type BackupReply } from './backup-service';
import { SETTING, PROVIDER_EPOCH, status, reconcile, invalidateProviderAccess } from './provider';
import { isUi, canOpenPreviewDiagnostic, authorizePreview } from './authorization';
import { serialize } from './queue';
import { cancelCaptures, recoverDeletion } from './maintenance';
import { handleManagement } from './management-commands';
import { handleCapture, openArchiveCapture, handleArchiveRead, verifyOriginalSource, recoverCaptures } from './archive-commands';
import { handleCuration } from './curation-commands';

const MENU = 'akm-preview-selection';
const KEEP_MENU = 'akm-keep-selection';
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
  if (management) return handleManagement(management, sender);
  if (exactKeys(value, ['protocolVersion', 'type', 'generation', 'sourceId']) && value.protocolVersion === 1 && value.type === 'VerifyOriginalSource' && isId(value.generation) && isId(value.sourceId)) {
    return verifyOriginalSource({ generation: value.generation, sourceId: value.sourceId }, sender);
  }
  const captureCommand = parseCaptureCommand(value);
  if (captureCommand) return handleCapture(captureCommand, sender);
  const openArchive = parseArchiveOpen(value);
  if (openArchive) return openArchiveCapture(openArchive, sender);
  const archiveCommand = parseArchiveRead(value);
  if (archiveCommand) return handleArchiveRead(archiveCommand, sender);
  const curationCommand = parseCurationCommand(value);
  if (curationCommand) return handleCuration(curationCommand, sender);
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
    if (!canOpenPreviewDiagnostic(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
    await openPreviewDiagnostic(command.code);
    return { ok: true };
  }
  if (command.type === 'AuthorizePreview') return authorizePreview(command.route, sender);
  if (!isUi(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
  if (command.type === 'SetProviderEnabled') {
    invalidateProviderAccess(); // Invalidate pending admissions before queued settings I/O.
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
chrome.permissions.onRemoved.addListener(() => { invalidateProviderAccess(); void serialize(async () => { await chrome.storage.local.set({ [PROVIDER_EPOCH]: crypto.randomUUID() }); await reconcile(); }).catch(() => undefined); });
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
