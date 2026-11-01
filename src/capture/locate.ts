import type { SourceRef } from '../shared/archive';
import { canonicalRoute } from '../shared/protocol';
import { isExcludedContent, MESSAGE, projectMessage } from './selection';

export type SourceLocation = 'verified' | 'ambiguous' | 'missing' | 'changed' | 'unavailable';
export function locateOriginal(route: string, anchor: SourceRef['originalPageAnchor']): SourceLocation {
  if (canonicalRoute(location.href) !== route || !anchor?.locator) return 'unavailable';
  const roots = Array.from(document.querySelectorAll(MESSAGE)).filter(root => !isExcludedContent(root) &&
    (root.getAttribute('data-message-id') ?? root.getAttribute('data-chatgpt-selection-message-id')) === anchor.locator);
  if (roots.length > 1) return 'ambiguous';
  if (!roots.length) return 'missing';
  const root = roots[0]!;
  const declared = root.getAttribute('data-chatgpt-selection-conversation-id');
  if (declared && !route.endsWith(`/c/${declared}`)) return 'unavailable';
  const projection = projectMessage(root), matches: number[] = [];
  for (let start = projection.text.indexOf(anchor.quote); start >= 0; start = projection.text.indexOf(anchor.quote, start + 1)) {
    if (projection.text.slice(0, start).endsWith(anchor.prefix) && projection.text.slice(start + anchor.quote.length).startsWith(anchor.suffix)) matches.push(start);
  }
  if (canonicalRoute(location.href) !== route) return 'unavailable';
  if (!matches.length) return projection.text.includes(anchor.quote) ? 'ambiguous' : 'changed';
  if (matches.length > 1) return 'ambiguous';
  const start = matches[0]!, end = start + anchor.quote.length;
  const first = projection.nodes.find(entry => start >= entry.start && start < entry.start + entry.node.length);
  const last = projection.nodes.find(entry => end > entry.start && end <= entry.start + entry.node.length);
  if (!first || !last) return 'unavailable';
  const range = document.createRange(); range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
  getSelection()?.removeAllRanges(); getSelection()?.addRange(range); root.scrollIntoView({ block: 'center' });
  return 'verified';
}
