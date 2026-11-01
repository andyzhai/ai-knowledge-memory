import { EMBEDDING_SIGNATURE, type EmbeddingProvider, type SemanticReply, type SemanticRequest } from '../shared/semantic';
import { SEARCH_POLICY_VERSION } from '../shared/search';
import { SemanticIndex } from './semantic';

export function createSemanticWorkerHandler(load: () => Promise<EmbeddingProvider>, post: (reply: SemanticReply) => void) {
  const index = new SemanticIndex();
  let epoch = 0, latestQuery = -1, latestBuild = -1;
  let provider: EmbeddingProvider | undefined, pending: Extract<SemanticRequest, { type: 'search' }> | undefined, busy = false;
  async function drain() {
    if (busy || !provider) return;
    busy = true;
    try {
      while (pending) {
        const request = pending; pending = undefined;
        const current = epoch, start = performance.now();
        try {
          const result = await index.search(request.query, request.options, request.marker, provider);
          if (current === epoch && request.queryId === latestQuery) post({ type: 'results', queryId: request.queryId, marker: request.marker,
            signature: EMBEDDING_SIGNATURE, result, elapsedMs: performance.now() - start });
        } catch {
          if (current === epoch && request.queryId === latestQuery) post({ type: 'error', message: 'Meaning search failed. Lexical search remains available.' });
        }
      }
    } finally { busy = false; }
  }
  return async (request: SemanticRequest) => {
    if (!request?.marker || request.signature !== EMBEDDING_SIGNATURE || request.marker.policyVersion !== SEARCH_POLICY_VERSION
      || typeof request.marker.generation !== 'string' || !Number.isSafeInteger(request.marker.dataSeq) || request.marker.dataSeq < 0) {
      ++epoch; index.clear(); provider = undefined; pending = undefined;
      post({ type: 'error', message: 'Incompatible meaning index. Lexical search remains available.' }); return;
    }
    if (request.type === 'build') {
      if (!Number.isSafeInteger(request.buildId) || request.buildId <= latestBuild) return;
      latestBuild = request.buildId;
      const current = ++epoch, start = performance.now(); index.clear(); provider = undefined; pending = undefined;
      try {
        const loaded = await load();
        if (current !== epoch) return;
        if (loaded.signature !== EMBEDDING_SIGNATURE) throw new Error('Wrong provider signature.');
        const chunks = await index.build(request.documents, request.marker, loaded);
        if (current !== epoch || chunks === null) return;
        provider = loaded;
        post({ type: 'ready', buildId: request.buildId, marker: request.marker, signature: EMBEDDING_SIGNATURE, chunks, elapsedMs: performance.now() - start });
      } catch {
        if (current !== epoch) return;
        index.clear(); post({ type: 'error', message: 'Packaged model failed verification or loading. Lexical search remains available.' });
      }
    } else if (request.type === 'search' && Number.isSafeInteger(request.queryId) && request.queryId > latestQuery && typeof request.query === 'string') {
      latestQuery = request.queryId; pending = request; await drain();
    }
  };
}
