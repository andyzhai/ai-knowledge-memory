import { fail } from '../shared/knowledge';

const views = new Set<chrome.runtime.Port>();
let paused: string | undefined;
let currentNotice = '';
const acknowledgements = new Map<chrome.runtime.Port, () => void>();
export function registerViews(allowed: (sender: chrome.runtime.MessageSender) => boolean, ready: () => Promise<unknown>) {
  chrome.runtime.onConnect?.addListener(port => {
    if (port.name !== 'library-view' || !port.sender || !allowed(port.sender)) { port.disconnect(); return; }
    views.add(port);
    port.onDisconnect.addListener(() => { views.delete(port); acknowledgements.get(port)?.(); acknowledgements.delete(port); });
    port.onMessage.addListener(message => { if (message?.type === 'cleared' && message.operationId === paused) acknowledgements.get(port)?.(); });
    void ready().then(() => {
      if (views.has(port)) port.postMessage(paused ? { type: 'pause', operationId: paused } : { type: 'ready', notice: currentNotice });
    }).catch(() => { if (views.has(port)) port.postMessage({ type: 'pause', operationId: paused ?? 'recovery' }); });
  });
}
export async function pauseViews(operationId: string) {
  paused = operationId;
  // An idle worker can restart while an existing view reconnects its port.
  // Wait for every live library document; a missing port is not proof that its
  // displayed snippets have gone away. New views start behind the UI gate.
  const deadline = Date.now() + 5000;
  while (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB', 'SIDE_PANEL'] });
    const documents = contexts.filter(context => context.documentUrl && ['/library.html', '/sidepanel.html'].includes(new URL(context.documentUrl).pathname));
    if (documents.every(context => [...views].some(port => port.sender?.documentId === context.documentId))) break;
    if (Date.now() >= deadline) fail('VIEWS_BUSY');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await Promise.all([...views].map(port => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { acknowledgements.delete(port); reject(new Error('VIEWS_BUSY')); }, 5000);
    const done = () => { clearTimeout(timer); acknowledgements.delete(port); resolve(); };
    acknowledgements.set(port, done);
    try { port.postMessage({ type: 'pause', operationId }); } catch { views.delete(port); done(); }
  }))).catch(() => fail('VIEWS_BUSY'));
}
export function resumeViews(notice = '') {
  paused = undefined;
  currentNotice = notice;
  for (const port of views) { try { port.postMessage({ type: 'ready', notice }); } catch { views.delete(port); } }
}
