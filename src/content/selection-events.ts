import type { Reply } from '../shared/protocol';

type Handlers = {
  onSelection: () => void;
  onContextMenu: (event: Event) => void;
  onPointerDown: (event: PointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  refresh: () => void;
  checkRoute: () => void;
  onNavigation: () => void;
  onMessage: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (reply: Reply) => void) => void;
};

export function listenForSelectionEvents({ onSelection, onContextMenu, onPointerDown, onKeyDown, refresh, checkRoute, onNavigation, onMessage }: Handlers): () => void {
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
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
  return () => {
    observer.disconnect();
    window.removeEventListener('selectionchange', onSelection, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pointerup', refresh, true);
    window.removeEventListener('keyup', refresh, true);
    window.removeEventListener('popstate', checkRoute);
    navigation?.removeEventListener('currententrychange', onNavigation);
    chrome.runtime.onMessage.removeListener(onMessage);
  };
}
