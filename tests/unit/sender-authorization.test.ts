import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/storage/repository', () => ({
  activeRepository: vi.fn(async () => ({
    generation: 'mock-gen',
    db: { meta: { checkReady: vi.fn(async () => ({ dataSeq: 0, generation: 'mock-gen', status: 'ready', schemaVersion: 1, writeFence: null })) } },
    checkReady: vi.fn(async () => ({ dataSeq: 0, generation: 'mock-gen', status: 'ready', schemaVersion: 1, writeFence: null })),
  })),
  closeRepository: vi.fn(),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const EXT = 'test-extension';

function mockSender(overrides: Record<string, unknown> = {}): chrome.runtime.MessageSender {
  return {
    id: EXT,
    frameId: 0,
    documentId: 'doc-001',
    tab: { id: 42, incognito: false },
    url: 'https://chatgpt.com/c/test-conv',
    ...overrides,
  } as chrome.runtime.MessageSender;
}

async function load() {
  const noopEvent = { addListener: vi.fn() };
  vi.stubGlobal('chrome', {
    runtime: { id: EXT, getURL: (p: string) => `chrome-extension://${EXT}/${p}`, onMessage: noopEvent, onInstalled: noopEvent, onStartup: noopEvent },
    storage: { local: { get: async () => ({ chatgptProbeEnabled: true }), set: async () => {}, setAccessLevel: async () => {} } },
    permissions: { contains: async () => true, onAdded: noopEvent, onRemoved: noopEvent },
    scripting: { getRegisteredContentScripts: async () => [{}], executeScript: async () => {} },
    tabs: { query: async () => [{ id: 7 }], sendMessage: async () => undefined, create: async () => undefined },
    sidePanel: { setPanelBehavior: async () => {} },
    contextMenus: { onClicked: noopEvent },
    commands: { onCommand: noopEvent }, action: { setBadgeText: vi.fn(), setTitle: vi.fn() },
  });
  const mod = await import('../../src/background/service-worker');
  return mod.senderCheckFailure;
}

type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (reply: unknown) => void) => boolean;

const DEFAULT_TAB_URL = 'https://chatgpt.com/c/conversation-b';

async function loadWithListener(tabUrl = DEFAULT_TAB_URL): Promise<{ listener: MessageListener }> {
  let listener: MessageListener | null = null;
  const noopEvent = { addListener: vi.fn() };
  const onMessage = { addListener: (cb: MessageListener) => { listener = cb; } };
  const sendMessage = vi.fn(async (_tabId: number, message: unknown) => {
    const msg = message as { type?: string };
    if (msg.type === 'ValidateSelectionIntent') return { ok: true };
    if (msg.type === 'ValidateLoadedIntent') return { ok: true };
    return undefined;
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: EXT, getURL: (p: string) => `chrome-extension://${EXT}/${p}`,
      onMessage, onInstalled: noopEvent, onStartup: noopEvent,
      sendMessage: vi.fn(async () => undefined),
    },
    storage: { local: {
      get: async (key: string | string[] | null) => {
        const k = Array.isArray(key) ? key[0] : key;
        if (k === 'chatgptProbeEnabled') return { chatgptProbeEnabled: true };
        if (k === 'chatgptProviderEpoch') return { chatgptProviderEpoch: 'ep' };
        if (k === 'activeLibrary') return { activeLibrary: { generation: 'mock-gen', ready: true } };
        if (k === 'resetOperation') return { resetOperation: undefined };
        return {};
      },
      set: async () => {}, setAccessLevel: async () => {},
    } },
    permissions: { contains: async () => true, onAdded: noopEvent, onRemoved: noopEvent },
    scripting: {
      getRegisteredContentScripts: async () => [{ id: 'akm-chatgpt-a0' }],
      executeScript: async () => [],
    },
    tabs: {
      query: async () => [{ id: 42, url: tabUrl, incognito: false }],
      get: async (id: number) => ({ id, url: tabUrl, pendingUrl: undefined, incognito: false }),
      sendMessage,
      create: vi.fn(async () => ({})),
    },
    sidePanel: { setPanelBehavior: async () => {} },
    contextMenus: { onClicked: noopEvent, create: vi.fn(), removeAll: vi.fn(async () => {}) },
    commands: { onCommand: noopEvent }, action: { setBadgeText: vi.fn(), setTitle: vi.fn() },
  });
  await import('../../src/background/service-worker');
  await vi.waitFor(() => expect(listener).not.toBeNull());
  return { listener: listener! };
}

async function sendCommand(listener: MessageListener, command: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  return new Promise(resolve => {
    listener(command, sender, (reply: unknown) => resolve(reply));
  });
}

describe('MV3 frameId and origin compatibility for content-script senders', () => {
  it('provider content scripts cannot query backup metadata, export or import', async () => {
    const { listener } = await loadWithListener();
    for (const type of ['BackupInfo', 'ExportBackup', 'ReadBackupChunk', 'BeginBackupUpload', 'PreviewRestore', 'ConfirmRestore', 'ExportRecovery']) {
      expect(await sendCommand(listener, { protocolVersion: 1, type }, mockSender())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_CONTEXT' });
    }
  });
  it('accepts frameId undefined (tabbed mode) as valid top-frame sender', async () => {
    const check = await load();
    expect(check(mockSender({ frameId: undefined }), EXT)).toBeNull();
  });

  it('accepts frameId 0 (legacy mode) as valid top-frame sender', async () => {
    const check = await load();
    expect(check(mockSender({ frameId: 0 }), EXT)).toBeNull();
  });

  it('rejects non-zero frameId as sub-frame (unauthorized)', async () => {
    const check = await load();
    expect(check(mockSender({ frameId: 5 }), EXT)).toBe('non_zero_frame');
  });

  it('rejects negative frameId as sub-frame (unauthorized)', async () => {
    const check = await load();
    expect(check(mockSender({ frameId: -1 }), EXT)).toBe('non_zero_frame');
  });

  it('rejects missing documentId', async () => {
    const check = await load();
    expect(check(mockSender({ documentId: undefined }), EXT)).toBe('no_document_id');
  });

  it('rejects missing tab id', async () => {
    const check = await load();
    expect(check(mockSender({ tab: { id: undefined, incognito: false } }), EXT)).toBe('no_tab_id');
  });

  it('rejects undefined tab', async () => {
    const check = await load();
    expect(check(mockSender({ tab: undefined }), EXT)).toBe('no_tab_id');
  });

  it('rejects incognito tabs', async () => {
    const check = await load();
    expect(check(mockSender({ tab: { id: 42, incognito: true } }), EXT)).toBe('incognito');
  });

  it('rejects wrong extension id', async () => {
    const check = await load();
    expect(check(mockSender({ id: 'other-extension' }), EXT)).toBe('sender_id_mismatch');
  });

  it('rejects cross-origin senders', async () => {
    const check = await load();
    expect(check(mockSender({ url: 'https://evil.test/c/conversation' }), EXT)).toBe('cross_origin');
  });

  it('rejects missing url', async () => {
    const check = await load();
    expect(check(mockSender({ url: undefined }), EXT)).toBe('cross_origin');
  });

  it('accepts chatgpt.com origin regardless of route', async () => {
    const check = await load();
    expect(check(mockSender({ url: 'https://chatgpt.com/g/proj/c/conversation' }), EXT)).toBeNull();
    expect(check(mockSender({ url: 'https://chatgpt.com/c/anything' }), EXT)).toBeNull();
  });
});

describe('SPA navigation stale sender.url regression', () => {
  it('BeginSelection accepts current tab URL B while stale sender.url references document URL A', async () => {
    const { listener } = await loadWithListener();
    const reply = await sendCommand(listener, {
      protocolVersion: 1, type: 'BeginSelection',
      route: 'https://chatgpt.com/c/conversation-b', nonce: crypto.randomUUID(),
    }, mockSender({ url: 'https://chatgpt.com/c/conversation-a', tab: { id: 42, incognito: false } }));
    expect(reply).toEqual({ ok: true, generation: 'mock-gen', providerEpoch: 'ep' });
  });

  it('AuthorizePreview accepts current tab URL B while stale sender.url references document URL A', async () => {
    const { listener } = await loadWithListener();
    const reply = await sendCommand(listener, {
      protocolVersion: 1, type: 'AuthorizePreview', route: 'https://chatgpt.com/c/conversation-b',
    }, mockSender({ url: 'https://chatgpt.com/c/conversation-a', tab: { id: 42, incognito: false } }));
    expect(reply).toEqual({ ok: true });
  });

  it('BeginSelection accepts Project /g/{project}/c/{id} route after SPA navigation from a different conversation', async () => {
    const { listener } = await loadWithListener('https://chatgpt.com/g/proj/c/conversation-b');
    const reply = await sendCommand(listener, {
      protocolVersion: 1, type: 'BeginSelection',
      route: 'https://chatgpt.com/g/proj/c/conversation-b', nonce: crypto.randomUUID(),
    }, mockSender({ url: 'https://chatgpt.com/g/proj/c/conversation-a', tab: { id: 42, incognito: false } }));
    expect(reply).toEqual({ ok: true, generation: 'mock-gen', providerEpoch: 'ep' });
  });

  it('AuthorizePreview accepts Project /g/{project}/c/{id} route after SPA navigation', async () => {
    const { listener } = await loadWithListener('https://chatgpt.com/g/proj/c/conversation-b');
    const reply = await sendCommand(listener, {
      protocolVersion: 1, type: 'AuthorizePreview', route: 'https://chatgpt.com/g/proj/c/conversation-b',
    }, mockSender({ url: 'https://chatgpt.com/g/proj/c/conversation-a', tab: { id: 42, incognito: false } }));
    expect(reply).toEqual({ ok: true });
  });

  it('BeginSelection rejects a cross-origin stale sender.url even with valid current tab URL', async () => {
    const { listener } = await loadWithListener();
    const reply = await sendCommand(listener, {
      protocolVersion: 1, type: 'BeginSelection',
      route: 'https://chatgpt.com/c/conversation-b', nonce: crypto.randomUUID(),
    }, mockSender({ url: 'https://evil.test/c/conversation-a' }));
    expect(reply).toMatchObject({ ok: false, code: 'UNAUTHORIZED_CONTEXT' });
  });

  it('BeginSelection rejects when the current tab URL does not match the requested route (true navigation away)', async () => {
    const { listener } = await loadWithListener();
    const reply = await sendCommand(listener, {
      protocolVersion: 1, type: 'BeginSelection',
      route: 'https://chatgpt.com/c/conversation-a', nonce: crypto.randomUUID(),
    }, mockSender({ url: 'https://chatgpt.com/c/conversation-a', tab: { id: 42, incognito: false } }));
    expect(reply).toMatchObject({ ok: false, code: 'NAVIGATION_CHANGED' });
  });

  it('BeginSelection invokes checkIntent to challenge the live content script', async () => {
    const { listener } = await loadWithListener();
    const reply = await sendCommand(listener, {
      protocolVersion: 1, type: 'BeginSelection',
      route: 'https://chatgpt.com/c/conversation-b', nonce: crypto.randomUUID(),
    }, mockSender({ url: 'https://chatgpt.com/c/conversation-a', tab: { id: 42, incognito: false } }));
    expect(reply).toEqual({ ok: true, generation: 'mock-gen', providerEpoch: 'ep' });
  });
});
