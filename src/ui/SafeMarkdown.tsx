import { createElement, Fragment, type ReactNode } from 'react';
import type { Token, Tokens } from 'marked';
import { markdownTokens, safeLink } from '../shared/markdown';

// Only React text nodes and this fixed element allowlist. Never insert parser
// HTML, token attributes, images, embeds, style, or executable math/highlighters.
function render(tokens: Token[], depth = 0): ReactNode {
  return tokens.map((token, index) => {
    const children = () => 'tokens' in token && token.tokens ? render(token.tokens, depth + 1) : String('text' in token ? token.text : token.raw);
    let element: ReactNode;
    if (depth > 32) element = token.raw;
    else switch (token.type) {
      case 'space': element = null; break;
      case 'paragraph': element = <p>{children()}</p>; break;
      case 'heading': element = createElement(`h${token.depth}`, null, children()); break;
      case 'strong': element = <strong>{children()}</strong>; break;
      case 'em': element = <em>{children()}</em>; break;
      case 'del': element = <del>{children()}</del>; break;
      case 'code': element = <pre><code>{String(token.text)}</code></pre>; break;
      case 'codespan': element = <code>{String(token.text)}</code>; break;
      case 'br': element = <br />; break;
      case 'hr': element = <hr />; break;
      case 'blockquote': element = <blockquote>{children()}</blockquote>; break;
      case 'list': {
        const items = token.items.map((item: Tokens.ListItem, i: number) => <li key={i} className={item.task ? 'task-item' : undefined}>
          {item.task && <input type="checkbox" checked={!!item.checked} disabled aria-label={item.checked ? 'Completed task' : 'Incomplete task'} />}
          {render(item.tokens, depth + 1)}
        </li>);
        element = token.ordered ? <ol start={typeof token.start === 'number' ? token.start : undefined}>{items}</ol> : <ul>{items}</ul>; break;
      }
      case 'table': {
        element = <div className="markdown-table" role="region" aria-label="Markdown table" tabIndex={0}><table>
          <thead><tr>{token.header.map((cell: Tokens.TableCell, i: number) => <th key={i} scope="col" style={{ textAlign: token.align[i] ?? undefined }}>{render(cell.tokens, depth + 1)}</th>)}</tr></thead>
          <tbody>{token.rows.map((row: Tokens.TableCell[], i: number) => <tr key={i}>{row.map((cell: Tokens.TableCell, j: number) => <td key={j} style={{ textAlign: token.align[j] ?? undefined }}>{render(cell.tokens, depth + 1)}</td>)}</tr>)}</tbody>
        </table></div>; break;
      }
      case 'link': {
        const href = safeLink(String(token.href));
        element = href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children()}</a> : <span>{children()} (link disabled)</span>; break;
      }
      case 'image': element = <span>[Image not loaded: {String(token.text)}]</span>; break;
      case 'text': case 'escape': element = children(); break;
      default: element = <span className="literal-markup">{token.raw}</span>;
    }
    return <Fragment key={index}>{element}</Fragment>;
  });
}
export function SafeMarkdown({ body }: { body: string }) {
  try { return <div className="markdown">{render(markdownTokens(body))}</div>; }
  catch { return <pre className="markdown">{body}</pre>; }
}
