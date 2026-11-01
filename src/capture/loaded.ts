import { CaptureError, CONVERSATION, isExcludedContent, MESSAGE, messageRole, temporaryStatus } from './selection';
import { canonicalRoute } from '../shared/protocol';
import { MAX_BATCH_BYTES, MAX_LOADED_MESSAGES, validLoadedMessage, type LoadedMessage, type LoadedPlan } from '../shared/loaded-capture';
import type { Block } from '../shared/archive';

export type LoadedSnapshot = { route: string; plan: LoadedPlan; batches: LoadedMessage[][]; streaming: boolean };
const media = 'img,video,audio,canvas,svg,iframe,object,embed';
function visibleText(root: Node, warnings: Set<string>): string {
  if (root instanceof Element && isExcludedContent(root)) { warnings.add('hidden_or_control_content_omitted'); return ''; }
  if (root instanceof Element && root.matches('details:not([open])')) { warnings.add('collapsed_content_omitted'); return root.querySelector('summary') ? visibleText(root.querySelector('summary')!, warnings) : ''; }
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? '';
  if (root instanceof Element) {
    if (root.matches('br')) return '\n';
    if (root.matches(media)) { warnings.add('media_not_downloaded'); return `[Unsupported ${root.tagName.toLowerCase()}${root.getAttribute('alt') ? `: ${root.getAttribute('alt')}` : ''}]`; }
  }
  return Array.from(root.childNodes).map(node => visibleText(node, warnings)).join('');
}
function blocksOf(root: Element, warnings: Set<string>): Block[] {
  const blocks: Block[] = [];
  let inline = '';
  const flush = () => { if (inline.trim()) blocks.push({ kind: 'text', text: inline }); inline = ''; };
  const visit = (node: Node) => {
    if (!(node instanceof Element)) { inline += node.textContent ?? ''; return; }
    if (isExcludedContent(node)) { warnings.add('hidden_or_control_content_omitted'); return; }
    if (node.matches('details:not([open])')) { flush(); warnings.add('collapsed_content_omitted'); const summary = node.querySelector('summary'); if (summary) visit(summary); flush(); return; }
    const tag = node.tagName.toLowerCase();
    if (node.matches(media)) { flush(); blocks.push({ kind: 'unsupported', text: visibleText(node, warnings) }); return; }
    if (tag === 'pre') {
      flush(); const code = node.querySelector('code') ?? node;
      const language = /(?:^|\s)language-([\w+-]{1,80})(?:\s|$)/.exec(code.className)?.[1] ?? null;
      blocks.push({ kind: 'code', text: visibleText(code, warnings).replace(/\r\n?/g, '\n'), language }); return;
    }
    if (tag === 'table') {
      flush(); const rows = Array.from(node.querySelectorAll('tr')).filter(row => !isExcludedContent(row)).map(row => Array.from(row.children).filter(cell => !isExcludedContent(cell)).map(cell => visibleText(cell, warnings)));
      blocks.push({ kind: 'table', rows, text: rows.map(row => row.join('\t')).join('\n') }); warnings.add('table_layout_simplified'); for (const link of node.querySelectorAll('a[href]')) addLink(link); return;
    }
    if (node.matches('math,.katex,[data-math]')) {
      flush(); blocks.push({ kind: 'math', text: visibleText(node, warnings) || '[Math source unavailable]' }); warnings.add('math_visible_text_only'); return;
    }
    if (node.matches('p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol')) {
      // Complex nested blocks keep their own boundaries, especially code.
      if (node.querySelector('pre,table,math,.katex')) { flush(); node.childNodes.forEach(visit); flush(); return; }
      flush(); const text = visibleText(node, warnings);
      if (/^h[1-6]$/.test(tag)) blocks.push({ kind: 'heading', text, level: Number(tag[1]) as 1 });
      else if (tag === 'ul' || tag === 'ol') blocks.push({ kind: 'list', ordered: tag === 'ol', text: Array.from(node.children).filter(item => !isExcludedContent(item)).map(item => visibleText(item, warnings)).join('\n') });
      else blocks.push({ kind: tag === 'blockquote' ? 'quote' : 'paragraph', text });
      for (const link of node.querySelectorAll('a[href]')) addLink(link);
      return;
    }
    if (tag === 'a') { inline += visibleText(node, warnings); addLink(node); return; }
    if (tag === 'br') { inline += '\n'; return; }
    if (['div', 'section', 'article'].includes(tag)) { flush(); node.childNodes.forEach(visit); flush(); }
    else { warnings.add('inline_formatting_simplified'); node.childNodes.forEach(visit); }
  };
  const addLink = (link: Element) => {
    if (isExcludedContent(link)) return;
    let url: string | null = null;
    try { const parsed = new URL(link.getAttribute('href')!, location.href); if (['https:', 'http:'].includes(parsed.protocol) && parsed.href.length <= 2048) url = parsed.href; } catch { /* Explicit unavailable destination. */ }
    // Empty metadata block avoids duplicating visible prose in plainText.
    blocks.push({ kind: 'link', text: '', url });
    if (!url) warnings.add('link_destination_unavailable');
    if (link.hasAttribute('data-citation')) warnings.add('citation_metadata_unavailable');
  };
  root.childNodes.forEach(visit); flush();
  if (!blocks.some(block => block.text.trim())) { blocks.push({ kind: 'unsupported', text: '[No supported visible message content]' }); warnings.add('empty_or_unsupported_message'); }
  return blocks;
}
export function readLoadedConversation(url = location.href): LoadedSnapshot {
  const route = canonicalRoute(url);
  if (!route) throw new CaptureError('UNSUPPORTED_PAGE');
  const warnings = new Set(['experimental_selectors', 'earlier_history_and_other_branches_unknown']);
  const allRoots = Array.from(document.querySelectorAll(MESSAGE));
  const roots = allRoots.filter(root => !isExcludedContent(root));
  if (!roots.length) throw new CaptureError('ADAPTER_MISMATCH');
  if (roots.length > MAX_LOADED_MESSAGES) throw new CaptureError('TOO_MANY_MESSAGES');
  if (roots.some(root => root.parentElement?.closest(MESSAGE))) throw new CaptureError('AMBIGUOUS_MESSAGE_BOUNDARY');
  if (allRoots.length !== roots.length) warnings.add('hidden_messages_omitted');
  // Observed search-unit wrappers can expose omitted conversation content even
  // when its message layout is unsupported. They do not establish role or ID.
  if (Array.from(document.querySelectorAll(`${CONVERSATION} [data-chatgpt-search-unit-key]`)).some(unit =>
    !isExcludedContent(unit) && !unit.closest(MESSAGE) && !allRoots.some(root => unit.contains(root)))) {
    warnings.add('unsupported_conversation_units_omitted');
  }
  const ids = roots.map(root => root.getAttribute('data-message-id') ?? root.getAttribute('data-chatgpt-selection-message-id'));
  const stop = Array.from(document.querySelectorAll('[data-testid="stop-button"],button[aria-label="Stop generating"]')).some(element => !isExcludedContent(element.parentElement!) && element.getClientRects().length > 0);
  const observedAt = new Date().toISOString();
  const messages: LoadedMessage[] = roots.map((root, index) => {
    const declared = root.getAttribute('data-chatgpt-selection-conversation-id');
    if (declared && !route.endsWith(`/c/${declared}`)) throw new CaptureError('NAVIGATION_CHANGED');
    const role = messageRole(root), id = ids[index];
    const sourceMessageId = id && /^[\w-]{1,256}$/.test(id) && ids.filter(candidate => candidate === id).length === 1 ? id : null;
    if (!sourceMessageId) warnings.add('ambiguous_identity_separate_observation');
    if (role === 'unknown') warnings.add('role_unknown');
    const signal = root.closest('[data-is-streaming]')?.getAttribute('data-is-streaming');
    const completion = role === 'user' ? 'complete' : signal === 'true' || (stop && index === roots.length - 1) ? 'partial' : signal === 'false' ? 'complete' : 'unknown';
    if (completion === 'unknown') warnings.add('completion_signal_unavailable');
    return { sourceMessageId, role, blocks: blocksOf(root, warnings), completion, observedAt };
  });
  const status = temporaryStatus();
  if (status === 'unknown') warnings.add('temporary_detection_unavailable');
  const batches: LoadedMessage[][] = []; let batch: LoadedMessage[] = [], bytes = 0;
  for (const message of messages) {
    const size = new TextEncoder().encode(JSON.stringify(message)).length;
    if (size + 2048 > MAX_BATCH_BYTES) throw new CaptureError('MESSAGE_TOO_LARGE');
    if (!validLoadedMessage(message)) throw new CaptureError('UNSUPPORTED_BLOCK_LIMIT');
    bytes += size;
    if (bytes > 32 * 1024 * 1024) throw new CaptureError('CAPTURE_TOO_LARGE');
    if (batch.length === 8 || new TextEncoder().encode(JSON.stringify([...batch, message])).length + 2048 > MAX_BATCH_BYTES) { batches.push(batch); batch = []; }
    batch.push(message);
  }
  if (batch.length) batches.push(batch);
  return { route, streaming: messages.some(message => message.completion === 'partial'), batches,
    plan: { title: document.title.slice(0, 1000) || 'ChatGPT conversation', temporaryStatus: status, warnings: [...warnings],
      messageIds: messages.map(message => message.sourceMessageId), batches: batches.length, messages: messages.length } };
}
