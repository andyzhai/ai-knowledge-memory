import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function start(enabled: boolean, delivery: 'ok' | 'missing' | 'no-receipt' = 'ok', action: 'preview' | 'keep' = 'preview') {
  let menuClick!: (info: { menuItemId: string }, tab: { id: number }) => void;
  const noopEvent = { addListener: vi.fn() };
  const createTab = vi.fn(async () => ({}));
  const sendMessage = vi.fn(async (_tab: number, message: { type: string }) => {
    if (message.type === 'DisposeProbe') return;
    if (delivery === 'missing') throw new Error('Could not establish connection. Receiving end does not exist.');
    return delivery === 'ok' ? { ok: true } : undefined;
  });
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      onMessage: noopEvent, onInstalled: noopEvent, onStartup: noopEvent },
    storage: { local: { get: async () => ({ chatgptProbeEnabled: enabled }), set: async () => {}, setAccessLevel: async () => {} } },
    permissions: { contains: async () => enabled, onAdded: noopEvent, onRemoved: noopEvent },
    scripting: { getRegisteredContentScripts: async () => enabled ? [{}] : [], executeScript: async () => {} },
    tabs: { query: async () => [{ id: 7 }], sendMessage, create: createTab },
    sidePanel: { setPanelBehavior: async () => {} },
    contextMenus: { onClicked: { addListener: (callback: typeof menuClick) => { menuClick = callback; } } },
    commands: { onCommand: noopEvent }, action: { setBadgeText: vi.fn(), setTitle: vi.fn() },
  });
  await import('../../src/background/service-worker');
  menuClick({ menuItemId: action === 'keep' ? 'akm-keep-selection' : 'akm-preview-selection' }, { id: 7 });
  return { createTab, sendMessage };
}

describe('explicit context-menu delivery feedback', () => {
  it('dispatches the native Keep menu to the capture path rather than the preview path', async () => {
    const { sendMessage } = await start(true, 'ok', 'keep');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(7, { type: 'KeepSelection', source: 'context-menu' }, { frameId: 0 }));
  });
  it('shows a save diagnostic if the native Keep menu cannot reach the source script', async () => {
    const { createTab } = await start(true, 'missing', 'keep');
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://test-extension/library.html?saveError=CONTENT_SCRIPT_UNAVAILABLE' }));
  });
  it('opens a visible diagnostic while disabled without injecting or sending a capture request', async () => {
    const { createTab, sendMessage } = await start(false);
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://test-extension/library.html?previewError=PERMISSION_DENIED' }));
    expect(sendMessage.mock.calls.some(([, message]) => message.type === 'PreviewSelection')).toBe(false);
  });
  it.each(['missing', 'no-receipt'] as const)('reports %s content-script delivery instead of swallowing it', async delivery => {
    const { createTab } = await start(true, delivery);
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://test-extension/library.html?previewError=CONTENT_SCRIPT_UNAVAILABLE' }));
  });
  it('leaves acknowledged preview feedback with the content script', async () => {
    const { createTab, sendMessage } = await start(true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(7, { type: 'PreviewSelection', source: 'context-menu' }, { frameId: 0 }));
    expect(createTab).not.toHaveBeenCalled();
  });
});
