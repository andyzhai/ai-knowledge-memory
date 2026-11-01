import { readLoadedConversation, type LoadedSnapshot } from '../capture/loaded';
import { CaptureError, temporaryStatus } from '../capture/selection';
import { canonicalRoute } from '../shared/protocol';
import type { ArchiveOpen, CaptureCommand, CaptureEnvelope, CaptureReply } from '../shared/loaded-capture';

function send(command: CaptureCommand): Promise<Extract<CaptureReply, { ok: true }>>;
function send(command: ArchiveOpen): Promise<{ ok: true }>;
async function send(command: CaptureCommand | ArchiveOpen): Promise<Extract<CaptureReply, { ok: true }> | { ok: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unconfirmed = command.type === 'OpenArchiveCapture' ? 'OPEN_UNCONFIRMED' : 'WRITE_UNCONFIRMED';
  try {
    const reply = await Promise.race([chrome.runtime.sendMessage(command) as Promise<CaptureReply>, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CaptureError(unconfirmed)), 10_000);
    })]);
    if (!reply?.ok) throw new CaptureError(reply && 'code' in reply ? reply.code : unconfirmed);
    return reply;
  } finally { clearTimeout(timer); }
}
export function installLoadedControls(shadow: ShadowRoot): () => void {
  let disposed = false, serial = 0, route = canonicalRoute(location.href), busy = false;
  let intent: { nonce: string; route: string; snapshot?: LoadedSnapshot; envelope?: CaptureEnvelope; allowed: boolean; requiresAllowance: boolean } | undefined;
  const open = document.createElement('button'); open.textContent = 'Save loaded conversation';
  const panel = document.createElement('section'); panel.hidden = true; panel.setAttribute('aria-label', 'Loaded conversation capture');
  Object.assign(panel.style, { background: '#fff', color: '#172e2a', padding: '16px', border: '2px solid #173b35', borderRadius: '8px', maxWidth: 'min(440px, 85vw)', maxHeight: '65vh', overflow: 'auto', font: '14px system-ui' });
  shadow.prepend(open, panel);
  function show(message: string) { if (disposed) return; panel.hidden = false; panel.replaceChildren(); const p = document.createElement('p'); p.textContent = message; p.setAttribute('role', 'status'); panel.append(p); }
  function button(label: string, action: () => void) { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', action); panel.append(b); return b; }
  function valid(current: NonNullable<typeof intent>) {
    if (disposed || intent !== current || canonicalRoute(location.href) !== current.route) throw new CaptureError('NAVIGATION_CHANGED');
  }
  async function cancel() {
    const current = intent; ++serial;
    if (current?.envelope) {
      try { await send({ ...current.envelope, type: 'InterruptArchiveCapture' }); }
      catch { /* Recovery checks the live owner after intent is released. */ }
    }
    intent = undefined; busy = false;
    show(current?.envelope ? 'Capture stopped. Any committed batches remain in Archive; refresh Archive to recover an unconfirmed interruption.' : 'Cancelled. No capture was submitted.');
    button('Close capture', () => { panel.hidden = true; });
  }
  function summary(partial = false) {
    const current = intent; if (!current?.snapshot) return;
    const snapshot = current.snapshot;
    show(`${snapshot.plan.messages} loaded messages on the observed branch. Earlier messages and other branches may be missing. Completion: ${snapshot.streaming ? 'partial' : snapshot.plan.warnings.includes('completion_signal_unavailable') ? 'unknown' : 'observed complete'}. Temporary mode: ${snapshot.plan.temporaryStatus}. Saves to Archive only.`);
    const warnings = document.createElement('p'); warnings.textContent = snapshot.plan.warnings.map(w => w.replaceAll('_', ' ')).join('; '); panel.append(warnings);
    if (snapshot.plan.temporaryStatus === 'temporary' && !current.allowed) {
      const explanation = document.createElement('p'); explanation.textContent = 'Saving creates a local copy of this temporary conversation. Allowance ends when you leave this conversation.'; panel.append(explanation);
      button('Allow saving this conversation', () => { current.allowed = true; summary(partial); });
    } else button(partial ? 'Save partial now' : 'Confirm Archive capture', () => { void save(); });
    button('Cancel capture', () => { void cancel(); });
  }
  async function start() {
    if (busy || intent?.envelope) return;
    const token = ++serial;
    intent = { nonce: crypto.randomUUID(), route: canonicalRoute(location.href) ?? '', allowed: false, requiresAllowance: temporaryStatus() === 'temporary' };
    const current = intent;
    try {
      current.snapshot = readLoadedConversation();
      if (current.snapshot.streaming) {
        busy = true; show('A loaded response is streaming. Waiting up to 15 seconds for an explicit completion signal…');
        button('Cancel capture', () => { void cancel(); });
        const deadline = performance.now() + 15_000;
        do {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (serial !== token) return;
          valid(current); current.snapshot = readLoadedConversation();
        } while (current.snapshot.batches.flat().some(message => message.role !== 'user' && message.completion !== 'complete') && performance.now() < deadline);
        // Disappearance of Stop is not an affirmative completion observation.
        if (current.snapshot.batches.flat().some(message => message.role !== 'user' && message.completion !== 'complete')) current.snapshot.streaming = true;
      }
      valid(current); summary(current.snapshot.streaming);
    } catch (error) { show(`Capture unavailable: ${error instanceof CaptureError ? error.code : 'ADAPTER_MISMATCH'}. No content was submitted.`); }
    finally { if (token === serial) busy = false; }
  }
  async function save() {
    const current = intent; if (!current?.snapshot || busy) return;
    busy = true;
    try {
      valid(current); show('Saving loaded messages to Archive…');
      if (!current.envelope) {
        const handshake = await send({ protocolVersion: 1, type: 'BeginLoadedCapture', route: current.route, nonce: current.nonce });
        valid(current);
        if (!('generation' in handshake)) throw new CaptureError('WRITE_UNCONFIRMED');
        current.envelope = { protocolVersion: 1, generation: handshake.generation, providerEpoch: handshake.providerEpoch, sessionId: crypto.randomUUID(),
          route: current.route, nonce: current.nonce, issuedAt: new Date().toISOString() };
      }
      const envelope = current.envelope;
      // Repeating Start returns the original session. Status, not volatile local
      // counters, chooses the next batch after an uncertain acknowledgement.
      await send({ ...envelope, type: 'StartArchiveCapture', plan: current.snapshot.plan });
      let reply = await send({ ...envelope, type: 'ArchiveCaptureStatus' });
      if (!('progress' in reply)) throw new CaptureError('WRITE_UNCONFIRMED');
      if (reply.progress.status === 'interrupted') throw new CaptureError('CAPTURE_CLOSED');
      for (let number = reply.progress.nextExpectedBatch; number < current.snapshot.batches.length; number++) {
        valid(current);
        reply = await send({ ...envelope, type: 'ArchiveCaptureBatch', number, messages: current.snapshot.batches[number]! });
        valid(current);
        if (!('progress' in reply)) throw new CaptureError('WRITE_UNCONFIRMED');
        show(`Committed ${reply.progress.committedMessages} of ${current.snapshot.plan.messages} loaded messages. Capture is not finalized yet.`);
      }
      valid(current);
      reply = await send({ ...envelope, type: 'FinishArchiveCapture' });
      if (!('progress' in reply) || reply.progress.status !== 'completed') throw new CaptureError('WRITE_UNCONFIRMED');
      valid(current);
      show(`Saved ${reply.progress.committedMessages} loaded messages to Archive. Earlier messages and other branches may be missing. Knowledge is unchanged.`);
      const command: ArchiveOpen = { protocolVersion: 1, type: 'OpenArchiveCapture', generation: reply.progress.generation, captureId: reply.progress.captureId };
      const openNotice = document.createElement('p'); openNotice.setAttribute('role', 'status');
      const openCapture = button('Open Archive capture', () => {
        openCapture.disabled = true; openNotice.textContent = '';
        void send(command).catch(error => {
          if (!disposed && openCapture.isConnected) openNotice.textContent = `Could not open Archive: ${error instanceof CaptureError ? error.code : 'OPEN_UNCONFIRMED'}. Your capture is saved. Retry opening, or open Archive from the extension library.`;
        }).finally(() => { openCapture.disabled = false; });
      });
      panel.append(openNotice);
      intent = undefined; button('Close capture', () => { panel.hidden = true; });
    } catch (error) {
      if (disposed) return;
      show(`Capture not confirmed: ${error instanceof CaptureError ? error.code : 'WRITE_UNCONFIRMED'}. Committed batches remain in Archive.`);
      if (intent === current) { button('Retry same capture', () => { void save(); }); button('Cancel capture', () => { void cancel(); }); }
    } finally { busy = false; }
  }
  const navigate = () => {
    if (intent) { intent = undefined; ++serial; busy = false; show('Conversation changed. Capture stopped; any committed batches remain under the original conversation in Archive.'); }
    route = canonicalRoute(location.href); open.hidden = !route;
  };
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  const onPop = () => { if (route !== canonicalRoute(location.href)) navigate(); };
  const observer = new MutationObserver(onPop); observer.observe(document.documentElement, { childList: true, subtree: true });
  const onMessage = (value: { type?: string; nonce?: string; route?: string }, sender: chrome.runtime.MessageSender, respond: (reply: { ok: boolean; code?: string }) => void) => {
    if (sender.id === chrome.runtime.id && value?.type === 'ClearPendingCaptures') { intent = undefined; ++serial; busy = false; panel.hidden = true; panel.replaceChildren(); return; }
    if (sender.id !== chrome.runtime.id || value?.type !== 'ValidateLoadedIntent') return;
    if (intent && temporaryStatus() === 'temporary') intent.requiresAllowance = true;
    const same = !disposed && intent?.nonce === value.nonce && intent?.route === value.route && canonicalRoute(location.href) === value.route;
    respond(same && (!intent!.requiresAllowance || intent!.allowed) ? { ok: true } : { ok: false, code: same ? 'TEMPORARY_ALLOW_REQUIRED' : 'NAVIGATION_CHANGED' });
  };
  open.addEventListener('click', event => { if (event.isTrusted) void start(); }); open.hidden = !route;
  navigation?.addEventListener('currententrychange', navigate); window.addEventListener('popstate', onPop); chrome.runtime.onMessage.addListener(onMessage);
  return () => { disposed = true; intent = undefined; ++serial; observer.disconnect(); navigation?.removeEventListener('currententrychange', navigate); window.removeEventListener('popstate', onPop); chrome.runtime.onMessage.removeListener(onMessage); open.remove(); panel.remove(); };
}
