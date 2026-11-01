import { canonicalRoute, MAX_FRAGMENTS, MAX_SELECTION_BYTES } from '../shared/protocol';
import type { SelectionFragment, SelectionSnapshot } from '../shared/curation';

export const EXTRACTOR_VERSION = 'a2-dom-text-2';
// The explicit message boundary is the evidence, not its layout wrapper. A
// semantic main, portal or changed page shell must not change source identity.
// Do not infer roles from article/markdown classes when this metadata is absent.
const EXPLICIT_MESSAGE = '[data-message-author-role],[data-chatgpt-selection-message-id][data-chatgpt-selection-conversation-id]';
export const CONVERSATION = '[data-chatgpt-conversation-selection-target="true"]';
const USER_BUBBLE = '[data-user-message-bubble="true"]';
// Observed October 20: user bubbles have neither legacy author metadata nor
// selection IDs. Restrict this fallback to the observed conversation container.
// Prefer an explicit ancestor boundary; nested bubbles are one message, not two.
export const MESSAGE = `${EXPLICIT_MESSAGE},${CONVERSATION} ${USER_BUBBLE}:not(:is(${EXPLICIT_MESSAGE},${USER_BUBBLE}) *)`;
const EXCLUDED = 'button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],script,style,nav,aside,[hidden],[aria-hidden="true"]';

export class CaptureError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export type Fragment = SelectionFragment;
export type FrozenSelection = SelectionSnapshot;

// Conservative visible signals only. Absence is unknown, never "ordinary".
// Labels are locale-sensitive; current provider parity remains a live-test gate.
export function temporaryStatus(): 'temporary' | 'unknown' {
  if (new URL(location.href).searchParams.get('temporary-chat') === 'true') return 'temporary';
  const candidates = document.querySelectorAll('[data-testid="temporary-chat-banner"],button[aria-pressed="true"], [role="status"]');
  return Array.from(candidates).some(element => element.getClientRects().length > 0 && !element.closest('[hidden],[aria-hidden="true"]') &&
    getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' &&
    (element.getAttribute('data-testid') === 'temporary-chat-banner' || /^(temporary chat|临时聊天)$/i.test((element.textContent ?? '').trim()))) ? 'temporary' : 'unknown';
}

export function codePointOffset(text: string, utf16: number): number {
  if (!Number.isInteger(utf16) || utf16 < 0 || utf16 > text.length) throw new CaptureError('INVALID_OFFSET');
  const before = text.charCodeAt(utf16 - 1);
  const after = text.charCodeAt(utf16);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) throw new CaptureError('SPLIT_SURROGATE');
  return Array.from(text.slice(0, utf16)).length;
}

export function isExcludedContent(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  if (!element || element.closest(EXCLUDED)) return true;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.matches('details:not([open])') && current !== element && !current.querySelector('summary')?.contains(element)) return true;
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  }
  return false;
}

function messageRoot(node: Node): Element {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const root = element?.closest(MESSAGE);
  if (!root || root.parentElement?.closest(MESSAGE)) throw new CaptureError('ADAPTER_MISMATCH');
  return root;
}

export function messageRole(root: Element): Fragment['role'] {
  const explicit = root.getAttribute('data-message-author-role');
  if (explicit !== null) return explicit === 'user' || explicit === 'assistant' ? explicit : 'unknown';
  // Observed on the live October 16 ChatGPT response. The selection container
  // supplies identity; its rendered message-style metadata supplies the role.
  // DIL renderer IDs, CSS classes and search-unit keys are not message identity.
  const styles = new Set(Array.from(root.querySelectorAll('[data-markdown-text-style]'))
    .map(element => element.getAttribute('data-markdown-text-style')));
  if (root.matches(USER_BUBBLE)) return styles.size === 0 && !root.hasAttribute('data-markdown-text-style') ? 'user' : 'unknown';
  if (styles.size === 1 && styles.has('assistant-message')) return 'assistant';
  return 'unknown';
}

function textNodes(root: Node): Text[] {
  if (root.nodeType === Node.TEXT_NODE) return [root as Text];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const result: Text[] = [];
  while (walker.nextNode()) result.push(walker.currentNode as Text);
  return result;
}

function selectedSlice(range: Range, node: Text): { start: number; end: number } | null {
  if (!range.intersectsNode(node)) return null;
  const start = range.startContainer === node ? range.startOffset : 0;
  const end = range.endContainer === node ? range.endOffset : node.length;
  return end > start ? { start, end } : null;
}

export function eligibleSelection(selection: Selection | null): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return false;
  const range = selection.getRangeAt(0);
  // Range boundaries may be elements with child offsets (including the message
  // itself). Inspect the selected text nodes, not boundary.parentElement.
  let found = false;
  try {
    for (const node of textNodes(range.commonAncestorContainer)) {
      const slice = selectedSlice(range, node);
      if (!slice) continue;
      if (isExcludedContent(node)) return false;
      if (!node.data.slice(slice.start, slice.end).trim() && !node.parentElement?.closest(MESSAGE)) continue;
      messageRoot(node);
      found = true;
    }
    return found;
  } catch { return false; }
}

// A0 deliberately tests a raw visible-text-node projection. It does not claim a
// complete block/Markdown converter. The browser's exact rendered selection is
// retained independently, since it can add paragraph separators.
export function projectMessage(root: Element): { text: string; nodes: { node: Text; start: number }[] } {
  let text = '';
  const nodes: { node: Text; start: number }[] = [];
  for (const node of textNodes(root)) {
    if (isExcludedContent(node)) continue;
    nodes.push({ node, start: text.length });
    text += node.data;
    if (text.length > 1024 * 1024) throw new CaptureError('MESSAGE_TOO_LARGE');
  }
  return { text, nodes };
}

export function freezeSelection(selection: Selection | null, url: string): FrozenSelection {
  const sourceUrl = canonicalRoute(url);
  if (!sourceUrl) throw new CaptureError('UNSUPPORTED_PAGE');
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) throw new CaptureError('NO_SELECTION');
  const range = selection.getRangeAt(0).cloneRange();
  const selectedText = selection.toString();
  if (new TextEncoder().encode(selectedText).length > MAX_SELECTION_BYTES) throw new CaptureError('PAYLOAD_TOO_LARGE');
  const roots = new Set<Element>();
  for (const node of textNodes(range.commonAncestorContainer)) {
    const slice = selectedSlice(range, node);
    if (!slice) continue;
    const selected = node.data.slice(slice.start, slice.end);
    if (isExcludedContent(node)) throw new CaptureError('EXCLUDED_CONTENT');
    const root = node.parentElement?.closest(MESSAGE);
    if (!root) {
      if (selected.trim()) throw new CaptureError('ADAPTER_MISMATCH');
      continue;
    }
    roots.add(messageRoot(node));
  }
  if (!roots.size) throw new CaptureError('ADAPTER_MISMATCH');
  if (roots.size > MAX_FRAGMENTS) throw new CaptureError('TOO_MANY_FRAGMENTS');
  const fragments: Fragment[] = [];
  for (const root of roots) {
    const projection = projectMessage(root);
    const selectedNodes = projection.nodes.flatMap(entry => {
      const slice = selectedSlice(range, entry.node);
      return slice ? [{ start: entry.start + slice.start, end: entry.start + slice.end }] : [];
    });
    const first = selectedNodes[0];
    const last = selectedNodes.at(-1);
    if (!first || !last) continue;
    const candidateId = root.getAttribute('data-message-id') ?? root.getAttribute('data-chatgpt-selection-message-id');
    const sourceMessageId = candidateId && /^[\w-]{1,256}$/.test(candidateId) && Array.from(document.querySelectorAll(MESSAGE)).filter(element =>
      (element.getAttribute('data-message-id') ?? element.getAttribute('data-chatgpt-selection-message-id')) === candidateId).length === 1 ? candidateId : null;
    const declaredConversation = root.getAttribute('data-chatgpt-selection-conversation-id');
    if (declaredConversation && !sourceUrl.endsWith(`/c/${declaredConversation}`)) throw new CaptureError('NAVIGATION_CHANGED');
    fragments.push({
      role: messageRole(root),
      sourceMessageId,
      kind: projection.nodes.filter(entry => selectedSlice(range, entry.node)).every(entry => entry.node.parentElement?.closest('pre,code')) ? 'code' : 'text',
      exactText: projection.text.slice(first.start, last.end),
      startCodePoint: codePointOffset(projection.text, first.start),
      endCodePoint: codePointOffset(projection.text, last.end),
    });
  }
  if (!fragments.length) throw new CaptureError('NO_SELECTION');
  const result: FrozenSelection = {
    sourceUrl, selectedText, fragments, extractorVersion: EXTRACTOR_VERSION,
    historyCoverage: 'unknown', branchCoverage: 'observed_only', temporaryStatus: temporaryStatus(), completion: 'unknown',
    warnings: ['experimental_selectors', 'temporary_detection_unavailable', 'completion_signal_unverified', 'raw_text_projection_not_block_conversion'],
  };
  if (result.temporaryStatus === 'temporary') result.warnings = result.warnings.filter(w => w !== 'temporary_detection_unavailable');
  if (fragments.some(fragment => !fragment.sourceMessageId)) result.warnings.push('original_identity_unavailable');
  if (fragments.some(fragment => fragment.role === 'unknown')) result.warnings.push('role_unknown');
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_SELECTION_BYTES) throw new CaptureError('PAYLOAD_TOO_LARGE');
  return result;
}
