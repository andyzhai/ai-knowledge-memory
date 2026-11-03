import { useRef } from 'react';
import { NOTE_TYPES, type NoteFields } from '../shared/knowledge';
import { clipboardMarkdown } from '../shared/clipboard-markdown';
import { SafeMarkdown } from './SafeMarkdown';

type Props = {
  draft: NoteFields;
  tags: string;
  placeholder: string;
  locked: boolean;
  preview: boolean;
  change: <K extends keyof NoteFields>(key: K, value: NoteFields[K]) => void;
  onTagsChange: (tags: string) => void;
  onPreviewChange: (preview: boolean) => void;
  onPlaceholderChange: (placeholder: string) => void;
  onNotice: (notice: string) => void;
};

// Draft ownership and save/retry intent stay in ManualLibrary.
export function NoteEditor({ draft, tags, placeholder, locked, preview, change, onTagsChange, onPreviewChange, onPlaceholderChange, onNotice }: Props) {
  const body = useRef<HTMLTextAreaElement>(null);
  return <fieldset disabled={locked}>
    <label htmlFor="note-title">Title (optional)</label><input id="note-title" value={draft.title} onChange={event => change('title', event.target.value)} />
    <div className="actions markdown-mode" role="group" aria-label="Markdown editor mode">
      <button type="button" className={preview ? 'secondary' : undefined} aria-pressed={!preview} aria-controls="note-body" onClick={() => onPreviewChange(false)}>Edit</button>
      <button type="button" className={preview ? undefined : 'secondary'} aria-pressed={preview} aria-controls="note-preview" onClick={() => onPreviewChange(true)}>Preview</button>
    </div>
    <div hidden={preview}>
    <label htmlFor="note-body">Body (Markdown)</label><textarea ref={body} id="note-body" required={!preview} rows={8} value={draft.bodyMarkdown} onChange={event => change('bodyMarkdown', event.target.value)} onPaste={event => {
      if (locked) return;
      const markdown = clipboardMarkdown(event.clipboardData);
      if (!markdown) return;
      event.preventDefault();
      const input = event.currentTarget;
      const start = input.selectionStart;
      change('bodyMarkdown', input.value.slice(0, start) + markdown + input.value.slice(input.selectionEnd));
      requestAnimationFrame(() => input.setSelectionRange(start + markdown.length, start + markdown.length));
    }} />
    </div>
    {preview && <div id="note-preview" role="region" aria-label="Markdown preview">{draft.bodyMarkdown ? <SafeMarkdown body={draft.bodyMarkdown} /> : <p>Nothing to preview yet.</p>}</div>}
    <p className="caption">Up to 256 KiB of UTF-8 text. Nothing is truncated.</p>
    <details><summary>Metadata and editing tools</summary>
    <label>Placeholder<input value={placeholder} onChange={e => onPlaceholderChange(e.target.value)} maxLength={100} /></label>
    <button type="button" disabled={preview} onClick={() => {
      const input = body.current; if (!input || input.selectionStart === input.selectionEnd) { onNotice('Select text in the body to replace.'); return; }
      change('bodyMarkdown', draft.bodyMarkdown.slice(0, input.selectionStart) + placeholder + draft.bodyMarkdown.slice(input.selectionEnd));
      onNotice('Draft text replaced. Existing source excerpts and earlier history remain until permanently removed.');
    }}>Replace selected text</button>
    <p className="caption">Use placeholders for passwords, tokens and other secrets. This library is not a password vault. Body edits preserve the current review state and do not rewrite source excerpts or erase earlier history.</p>
    <label htmlFor="note-type">Type</label><select id="note-type" value={draft.type} onChange={event => change('type', event.target.value as NoteFields['type'])}>{NOTE_TYPES.map(type => <option key={type} value={type}>{type.replace('_', ' ')}</option>)}</select>
    {draft.type === 'procedure' && <button type="button" onClick={() => change('bodyMarkdown', `${draft.bodyMarkdown}${draft.bodyMarkdown ? '\n\n' : ''}## Purpose\n\n## Prerequisites\n\n## Steps\n\n1. \n\n## Verification\n\n## Cautions\n`)}>Append procedure template</button>}
    <label htmlFor="note-tags">Tags (comma separated, up to 32)</label><input id="note-tags" value={tags} onChange={event => onTagsChange(event.target.value)} />
    <label htmlFor="note-explanation">Personal explanation</label><textarea id="note-explanation" value={draft.personalExplanation} onChange={event => change('personalExplanation', event.target.value)} />
    <label htmlFor="note-applicable">Applicable product or version</label><input id="note-applicable" value={draft.applicableVersion} onChange={event => change('applicableVersion', event.target.value)} />
    <label htmlFor="note-review">Review date</label><input id="note-review" type="date" value={draft.reviewAfter ?? ''} onChange={event => change('reviewAfter', event.target.value || null)} />
    </details>
  </fieldset>;
}
