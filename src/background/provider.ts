import { CHATGPT_MATCH, CONTENT_SCRIPT_ID, type Status } from '../shared/protocol';

export const SETTING = 'chatgptProbeEnabled';
export const PROVIDER_EPOCH = 'chatgptProviderEpoch';
let accessRevision = 0;
export function getAccessRevision(): number { return accessRevision; }
export function invalidateProviderAccess(): void { ++accessRevision; }

export async function status(): Promise<Status> {
  const [settings, granted, scripts] = await Promise.all([
    chrome.storage.local.get(SETTING),
    chrome.permissions.contains({ origins: [CHATGPT_MATCH] }),
    chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] }),
  ]);
  return { enabled: settings[SETTING] === true && granted, granted, registered: scripts.length > 0, milestone: 'A6' };
}

export async function reconcile(): Promise<void> {
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

export async function providerEpoch(): Promise<string> {
  const settings = await chrome.storage.local.get(PROVIDER_EPOCH);
  if (typeof settings[PROVIDER_EPOCH] === 'string') return settings[PROVIDER_EPOCH];
  const epoch = crypto.randomUUID(); await chrome.storage.local.set({ [PROVIDER_EPOCH]: epoch }); return epoch;
}

