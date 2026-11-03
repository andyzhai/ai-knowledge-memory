import { CHATGPT_ORIGIN, canonicalRoute, type Reply } from '../shared/protocol';
import { fail, KnowledgeError } from '../shared/knowledge';
import type { SourceBinding } from '../shared/curation';
import { status } from './provider';

export function isUi(sender: chrome.runtime.MessageSender): boolean {
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

export async function sourceBinding(sender: chrome.runtime.MessageSender, route: string, nonce: string): Promise<SourceBinding> {
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
export async function checkIntent(binding: SourceBinding, loaded = false): Promise<void> {
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
// Preview diagnostics deliberately check the sender origin, not its possibly
// stale SPA route. Capture writes additionally reject incognito senders.
export function canOpenPreviewDiagnostic(sender: chrome.runtime.MessageSender): boolean {
  return !(sender.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0) || !sender.documentId || sender.tab?.id === undefined ||
    originOf(sender.url) !== CHATGPT_ORIGIN);
}

export async function authorizePreview(routeInput: string, sender: chrome.runtime.MessageSender): Promise<Reply> {
  const route = canonicalRoute(routeInput);
  if (sender.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0) || !sender.documentId ||
      sender.tab?.id === undefined || !route || originOf(sender.url) !== CHATGPT_ORIGIN) {
    return { ok: false, code: 'UNSUPPORTED_PAGE' };
  }
  const tab = await chrome.tabs.get(sender.tab.id);
  if (canonicalRoute(tab.url ?? '') !== route || (tab.pendingUrl && canonicalRoute(tab.pendingUrl) !== route)) return { ok: false, code: 'NAVIGATION_CHANGED' };
  return (await status()).enabled ? { ok: true } : { ok: false, code: 'PERMISSION_DENIED' };
}
