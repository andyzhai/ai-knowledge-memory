import type { FrozenSelection } from '../capture/selection';

// This view retains no capture intent. The controller owns authorization,
// navigation epochs and exact retry payloads.
export function createSelectionPanel(onClose: () => void, isBusy: () => boolean) {
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
  function resetUi(): void { button.hidden = true; keepButton.hidden = true; panel.hidden = true; panel.replaceChildren(); }
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
    close.addEventListener('click', onClose);
    panel.append(close);
    panel.hidden = false;
    close.focus();
  }
  function keepMessage(text: string, snapshot?: FrozenSelection): void {
    showText(text, snapshot);
    panel.querySelector('strong')!.textContent = 'Knowledge selection';
  }
  function action(label: string, run: () => void): void {
    const control = document.createElement('button'); control.textContent = label;
    control.addEventListener('click', event => { if (event.isTrusted && !isBusy()) run(); }); panel.append(control);
  }
  return { host, shadow, button, keepButton, panel, resetUi, showText, keepMessage, action };
}
