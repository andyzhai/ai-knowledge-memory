import { SEARCH_POLICY_VERSION, type SearchDocument, type SearchMarker, type SearchOptions, type SearchResult, type SearchWorkerReply } from '../shared/search';
import { sameCanonicalMarker, type SearchReadCommand, type SearchReadReply } from '../shared/search-access';
import { EMBEDDING_SIGNATURE, type SemanticReply } from '../shared/semantic';

export type SearchView = { phase: 'loading' | 'ready' | 'error'; message: string; result?: SearchResult; documents: SearchDocument[]; elapsedMs?: number };
export type MeaningView = { phase: 'disabled' | 'loading' | 'ready' | 'error'; message: string; result?: SearchResult; documents: SearchDocument[] };
async function read(command: SearchReadCommand): Promise<Exclude<SearchReadReply, { ok: false }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      chrome.runtime.sendMessage('marker' in command ? { ...command, marker: { generation: command.marker.generation, dataSeq: command.marker.dataSeq } } : command) as Promise<SearchReadReply>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Search read timed out. Retry rebuilding the index.')), 15_000); }),
    ]);
    if (!reply?.ok) throw new Error(reply && 'code' in reply ? reply.code : 'Search read unavailable');
    return reply;
  } finally { clearTimeout(timer); }
}

// Each open view owns and disposes one lexical worker. Only the service worker
// reads canonical data; no search/cache code can mutate business records.
export class SearchSession {
  private worker?: Worker;
  private semanticWorker?: Worker;
  private semanticEnabled = false;
  private semanticReady = false;
  private documents: SearchDocument[] = [];
  private marker?: SearchMarker;
  private buildId = 0;
  private queryId = 0;
  private ready = false;
  private disposed = false;
  private query = '';
  private options: SearchOptions = {};
  private started = 0;
  private debounce?: ReturnType<typeof setTimeout>;
  constructor(private publish: (view: SearchView) => void, private publishMeaning: (view: MeaningView) => void = () => {}, private collection: 'knowledge' | 'archive' = 'knowledge') {}
  private read(command: SearchReadCommand) {
    const names: Record<string, string> = { GetSearchState: 'GetArchiveSearchState', ReadSearchPage: 'ReadArchiveSearchPage', HydrateSearchResults: 'HydrateArchiveSearchResults' };
    return read(this.collection === 'archive' ? { ...command, type: names[command.type] ?? command.type } as SearchReadCommand : command);
  }
  dispose() { this.disposed = true; ++this.buildId; ++this.queryId; clearTimeout(this.debounce); this.worker?.terminate(); this.semanticWorker?.terminate(); this.documents = []; }
  setSemantic(enabled: boolean) {
    enabled = enabled && this.collection === 'knowledge';
    this.semanticEnabled = enabled; this.semanticWorker?.terminate(); this.semanticWorker = undefined; this.semanticReady = false;
    this.publishMeaning({ phase: enabled ? 'loading' : 'disabled', message: enabled ? 'Loading packaged model · lexical search remains available.' : 'Meaning search disabled; in-memory model and vectors released.', documents: [] });
    if (enabled && this.marker) this.buildSemantic();
  }
  private buildSemantic() {
    if (!this.semanticEnabled || !this.marker || this.disposed) return;
    const buildId = this.buildId;
    try {
      const worker = new Worker(chrome.runtime.getURL('semantic-worker.js'), { type: 'module' });
      this.semanticWorker = worker;
      worker.onerror = () => { if (worker === this.semanticWorker) this.meaningFailed(); };
      worker.onmessage = event => { if (worker === this.semanticWorker) void this.receiveMeaning(event.data, buildId, worker); };
      worker.postMessage({ type: 'build', buildId, marker: this.marker, signature: EMBEDDING_SIGNATURE, documents: this.documents });
    } catch { this.meaningFailed(); }
  }
  private searchMeaning() {
    if (!this.semanticReady || !this.semanticEnabled || !this.marker || this.disposed) return;
    this.semanticWorker?.postMessage({ type: 'search', queryId: this.queryId, marker: this.marker, signature: EMBEDDING_SIGNATURE, query: this.query, options: this.options });
  }
  private meaningFailed() {
    this.semanticWorker?.terminate(); this.semanticWorker = undefined; this.semanticReady = false;
    if (!this.disposed) this.publishMeaning({ phase: 'error', message: 'Meaning search unavailable. Disable and enable to retry; lexical search remains available.', documents: [] });
  }
  private async receiveMeaning(reply: SemanticReply, buildId: number, worker: Worker) {
    if (this.disposed || !this.semanticEnabled || buildId !== this.buildId || worker !== this.semanticWorker) return;
    if (reply.type === 'error') { this.meaningFailed(); return; }
    if (reply.signature !== EMBEDDING_SIGNATURE || !sameCanonicalMarker(reply.marker, this.marker) || reply.marker.policyVersion !== SEARCH_POLICY_VERSION) return;
    if (reply.type === 'ready') {
      if (reply.buildId !== buildId) return;
      this.semanticReady = true; this.searchMeaning(); return;
    }
    if (reply.queryId !== this.queryId) return;
    const queryId = this.queryId, documents: SearchDocument[] = [];
    try {
      const ids = reply.result.hits.map(hit => hit.id);
      for (let start = 0; start < Math.max(1, ids.length); start += 8) {
        const current = await this.read({ protocolVersion: 1, type: 'HydrateSearchResults', marker: reply.marker, ids: ids.slice(start, start + 8) });
        if (this.disposed || !this.semanticEnabled || buildId !== this.buildId || queryId !== this.queryId || worker !== this.semanticWorker) return;
        if (!('documents' in current)) throw new Error('Invalid meaning hydration');
        documents.push(...current.documents);
      }
      const notes = new Map(documents.map(document => [document.note.id, document.note]));
      if (reply.result.hits.some(hit => notes.get(hit.id)?.recordVersion !== hit.recordVersion || notes.get(hit.id)?.contentHash !== hit.contentHash)) { void this.rebuild(); return; }
      this.publishMeaning({ phase: 'ready', message: reply.result.error ?? (this.query.trim() ? 'Related by meaning · nearest suggestions can be unrelated. Verify the original note.' : 'Enter a query for meaning suggestions.'), result: reply.result, documents });
    } catch (error) {
      if (this.disposed || buildId !== this.buildId || queryId !== this.queryId || worker !== this.semanticWorker) return;
      if (error instanceof Error && error.message === 'SEARCH_CHANGED') { void this.rebuild(); return; }
      this.meaningFailed();
    }
  }
  update(query: string, options: SearchOptions) {
    this.query = query; this.options = options; ++this.queryId;
    if (this.semanticEnabled && this.semanticWorker) this.publishMeaning({ phase: 'loading', message: this.semanticReady ? 'Looking for meaning suggestions…' : 'Model/index loading · lexical search remains available.', documents: [] });
    this.loading(this.ready ? 'Searching local Knowledge…' : 'Index rebuilding · results incomplete. Recent notes remain available below.');
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.search(), 75);
  }
  private loading(message: string) { if (!this.disposed) this.publish({ phase: 'loading', message: this.collection === 'archive' ? message.replaceAll('Knowledge', 'Archive').replace('Recent notes remain available below.', 'Only finalized or interrupted captures are searchable.') : message, documents: [] }); }
  private search() {
    if (!this.ready || !this.marker || this.disposed) return;
    this.started = performance.now();
    this.worker?.postMessage({ type: 'search', queryId: this.queryId, marker: this.marker, query: this.query, options: this.options });
    this.searchMeaning();
  }
  async reconcile() {
    const buildId = this.buildId;
    const queryId = this.queryId;
    try {
      const state = await this.read({ protocolVersion: 1, type: 'GetSearchState' });
      if (!this.disposed && buildId === this.buildId && !sameCanonicalMarker(state.marker, this.marker)) await this.rebuild();
    } catch (error) { if (buildId === this.buildId && queryId === this.queryId) this.failed(error); }
  }
  changed(generation: string, dataSeq: number) {
    if (!sameCanonicalMarker({ generation, dataSeq }, this.marker)) void this.rebuild();
  }
  async rebuild() {
    if (this.disposed) return;
    const buildId = ++this.buildId; ++this.queryId; this.ready = false; this.marker = undefined;
    clearTimeout(this.debounce);
    this.worker?.terminate(); this.worker = undefined;
    this.semanticWorker?.terminate(); this.semanticWorker = undefined; this.semanticReady = false; this.documents = [];
    if (this.semanticEnabled) this.publishMeaning({ phase: 'loading', message: 'Meaning index rebuilding · results incomplete.', documents: [] });
    this.loading('Index rebuilding · results incomplete. Recent notes remain available below.');
    try {
      const state = await this.read({ protocolVersion: 1, type: 'GetSearchState' });
      const documents: SearchDocument[] = [];
      let afterId: string | null = null;
      do {
        const page = await this.read({ protocolVersion: 1, type: 'ReadSearchPage', marker: state.marker, afterId });
        if (this.disposed || buildId !== this.buildId) return;
        if (!('documents' in page)) throw new Error('Invalid search page');
        documents.push(...page.documents); afterId = page.nextId;
      } while (afterId);
      if (this.disposed || buildId !== this.buildId) return;
      const marker: SearchMarker = { ...state.marker, policyVersion: SEARCH_POLICY_VERSION };
      this.marker = marker;
      this.documents = documents;
      const worker = new Worker(chrome.runtime.getURL('search-worker.js'), { type: 'module' });
      this.worker = worker;
      worker.onerror = () => { if (buildId === this.buildId) this.failed(new Error('The local search worker stopped. Rebuild the index to retry.')); };
      worker.onmessage = event => { void this.receive(event.data as SearchWorkerReply, buildId); };
      worker.postMessage({ type: 'build', buildId, marker, documents });
      this.buildSemantic();
    } catch (error) {
      if (buildId !== this.buildId || this.disposed) return;
      if (error instanceof Error && error.message === 'SEARCH_CHANGED') { void this.rebuild(); return; }
      this.failed(error);
    }
  }
  private async receive(reply: SearchWorkerReply, buildId: number) {
    if (this.disposed || buildId !== this.buildId) return;
    if (reply.type === 'error') { this.failed(new Error(reply.message)); return; }
    if (!sameCanonicalMarker(reply.marker, this.marker) || reply.marker.policyVersion !== SEARCH_POLICY_VERSION) return;
    if (reply.type === 'ready') {
      if (reply.buildId !== buildId) return;
      clearTimeout(this.debounce);
      this.ready = true; this.search(); return;
    }
    if (reply.queryId !== this.queryId) return;
    const queryId = this.queryId;
    try {
      const documents: SearchDocument[] = [];
      // Even a no-match response must recheck canonical freshness. Hydration
      // re-reads all metadata and text under the SAME canonical sequence.
      const ids = reply.result.hits.map(hit => hit.id);
      for (let start = 0; start < Math.max(ids.length, 1); start += 8) {
        const current = await this.read({ protocolVersion: 1, type: 'HydrateSearchResults', marker: reply.marker, ids: ids.slice(start, start + 8) });
        if (this.disposed || buildId !== this.buildId || queryId !== this.queryId) return;
        if (!('documents' in current)) throw new Error('Invalid search hydration');
        documents.push(...current.documents);
      }
      const current = new Map(documents.map(document => [document.note.id, document.note]));
      if (reply.result.hits.some(hit => {
        const note = current.get(hit.id);
        return !note || note.recordVersion !== hit.recordVersion || note.contentHash !== hit.contentHash;
      })) { void this.rebuild(); return; }
      this.publish({ phase: 'ready', message: reply.result.error ?? (this.query.trim() ? `${reply.result.total} matching ${this.collection === 'archive' ? 'Archive revisions' : 'notes'}` : this.collection === 'archive' ? 'Recent Archive' : 'Recent Knowledge'), result: reply.result, documents, elapsedMs: performance.now() - this.started });
    } catch (error) {
      if (this.disposed || buildId !== this.buildId || queryId !== this.queryId) return;
      if (error instanceof Error && error.message === 'SEARCH_CHANGED') { void this.rebuild(); return; }
      this.failed(error);
    }
  }
  private failed(error: unknown) {
    if (this.disposed) return;
    this.ready = false;
    if (this.semanticEnabled) this.meaningFailed();
    this.publish({ phase: 'error', message: error instanceof Error ? error.message : 'Local search is unavailable.', documents: [] });
  }
}
