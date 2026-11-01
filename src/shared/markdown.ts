import { Lexer, type Token } from 'marked';

export function markdownTokens(body: string): Token[] {
  return Lexer.lex(body, { gfm: true, breaks: false });
}
// A derived display/search representation, never used for source anchors or to
// reconstruct the original Markdown. Unsupported markup remains literal text.
export function markdownPlainText(body: string): string {
  function text(tokens: Token[], depth = 0): string {
    if (depth > 32) return tokens.map(token => token.raw).join('');
    return tokens.map(token => {
      if (token.type === 'list') return token.items.map((item: { tokens: Token[] }) => text(item.tokens, depth + 1)).join('\n');
      if (token.type === 'table') return token.raw;
      if (token.type === 'space' || token.type === 'br') return '\n';
      if ('tokens' in token && token.tokens) return text(token.tokens, depth + 1) + (['paragraph', 'heading', 'blockquote'].includes(token.type) ? '\n' : '');
      return 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
    }).join('');
  }
  return text(markdownTokens(body));
}

export function safeLink(value: string): string | null {
  try {
    // No relative/internal URLs, credentials, control characters, or signed URLs.
    if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return null;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/token|signature|credential|^sig$|^key$|^auth$|^x-amz-/i.test(key)) return null;
      if (/^utm_|^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return null; }
}
