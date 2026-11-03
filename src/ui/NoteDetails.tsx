import type { HistoryEntry, KnowledgeItem } from '../shared/knowledge';
import type { SourceRef } from '../shared/archive';
import { safeLink } from '../shared/markdown';
import { SafeMarkdown } from './SafeMarkdown';
import { DeleteControl } from './Management';

export function NoteMetadata({ note }: { note: KnowledgeItem }) {
  return <dl className="note-metadata">
    <dt>Title</dt><dd>{note.title || 'Untitled note'}</dd>
    <dt>Type</dt><dd>{note.type.replace('_', ' ')}</dd>
    <dt>Tags</dt><dd>{note.tags.join(', ') || 'None'}</dd>
    <dt>Personal explanation</dt><dd>{note.personalExplanation || 'None'}</dd>
    <dt>Applicable product or version</dt><dd>{note.applicableVersion || 'Not specified'}</dd>
    <dt>Review date</dt><dd>{note.reviewAfter || 'Not set'}</dd>
    <dt>Review state</dt><dd>{note.reviewState.replace('_', ' ')}</dd>
  </dl>;
}
export function NoteSources({ sources, generation, checks, onCheck }: {
  sources: SourceRef[]; generation: string; checks: Record<string, string>; onCheck: (source: SourceRef) => void;
}) {
  return <details className="context-section"><summary>Sources ({sources.length})</summary>
    {!sources.length && <p>This note has no retained source excerpts.</p>}
    {!!sources.length && <article aria-label="Local source excerpts"><h3>Local source excerpts</h3><p>These are retained excerpts, not necessarily a complete conversation. Check the original page to verify the exact quote.</p>
      {sources.map((source, index) => <div key={source.id} className="source-excerpt">
        <h4>Fragment {index + 1} · {source.sourceRole ?? 'unknown'} · {source.blockKind ?? 'text'}</h4>
        <pre className={source.blockKind === 'code' ? 'archive-code' : undefined}>{source.exactText}</pre>
        {source.sourceRemovedAt && <p>Archive source removed on {new Date(source.sourceRemovedAt).toLocaleString()}. This deliberately retained excerpt remains in Knowledge.</p>}
        <p className="caption">{source.sourceProvider ?? 'Unknown provider'} · {new Date(source.capturedAt).toLocaleString()} · retained excerpt anchor: {source.anchorStatus}. Original page identity: {source.originalPageAnchor ? 'observed; relocation unverified' : 'unresolved'}.</p>
        <p>Temporary mode: {source.temporaryStatus ?? 'unknown'}. {source.fidelityWarnings.map(warning => warning.replaceAll('_', ' ')).join('; ')}.</p>
        {source.sourceUrl && safeLink(source.sourceUrl) ? <a href={safeLink(source.sourceUrl)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open original conversation</a> : <p>Original URL unavailable.</p>}
        <button onClick={() => void onCheck(source)}>Check original in open ChatGPT tab</button><p role="status">{checks[source.id]}</p>
      </div>)}
    </article>}
    {sources.some(source => source.conversationId) && <details><summary>Manage Archive sources</summary>
      {[...new Map(sources.filter(s => s.conversationId).map(s => [s.conversationId!, s])).values()].map(source => <div key={source.conversationId!}>
        <h4>{source.sourceTitle}</h4>
        {source.captureId && <p><a href={chrome.runtime.getURL(`library.html?capture=${source.captureId}`)} target="_blank" rel="noopener noreferrer">Open retained Archive source</a></p>}
        <DeleteControl generation={generation} target={{ kind: 'conversation', conversationId: source.conversationId!, mode: 'keep_knowledge' }} label="Delete Archive source, keep Knowledge excerpts" />
        <DeleteControl generation={generation} target={{ kind: 'conversation', conversationId: source.conversationId!, mode: 'with_knowledge' }} label="Remove source and all dependent content permanently" />
      </div>)}
    </details>}
  </details>;
}

export function NoteHistory({ history, note, historyOffset, historical, historicalSources, disabled, onOpenRevision, onPage }: {
  history: HistoryEntry[]; note?: KnowledgeItem; historyOffset: number; historical?: KnowledgeItem; historicalSources: SourceRef[];
  disabled: boolean; onOpenRevision: (version: number) => void; onPage: (offset: number) => void;
}) {
  return <details className="context-section"><summary>History · Saved history ({note?.currentVersion} versions)</summary>
    <p>History retains earlier text until you confirm permanent deletion of the note or its source and dependent content.</p>
    <ul>{history.map(entry => <li key={entry.version}><button disabled={disabled} onClick={() => void onOpenRevision(entry.version)}>View version {entry.version}</button> {entry.changeReason} · {new Date(entry.changedAt).toLocaleString()}</li>)}</ul>
    {historyOffset > 0 && <button disabled={disabled} onClick={() => void onPage(Math.max(0, historyOffset - 50))}>Newer history</button>}
    {note && historyOffset + history.length < note.currentVersion && <button disabled={disabled} onClick={() => void onPage(historyOffset + 50)}>Older history</button>}
    {historical && <article aria-label="Saved revision"><h3>Version {historical.recordVersion}: {historical.title}</h3><SafeMarkdown body={historical.bodyMarkdown} /><NoteMetadata note={historical} />
      {historicalSources.map(source => <div key={source.id}><h4>{source.sourceTitle}</h4><pre>{source.exactText}</pre>{source.sourceRemovedAt && <p>Archive source removed; excerpt retained.</p>}</div>)}
    </article>}
  </details>;
}
