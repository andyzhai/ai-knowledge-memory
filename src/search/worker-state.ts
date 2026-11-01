import { SEARCH_POLICY_VERSION, sameSearchMarker, type SearchMarker, type SearchWorkerReply, type SearchWorkerRequest } from '../shared/search';
import { createKnowledgeIndex } from './lexical';

// One disposable index per owning UI. There is no canonical storage or network
// access in this worker, and no implicit corpus when the worker starts.
export function createSearchWorkerHandler(post: (reply: SearchWorkerReply) => void) {
  let index: ReturnType<typeof createKnowledgeIndex> | undefined;
  let marker: SearchMarker | undefined;
  let latestBuild = -1;
  let latestQuery = -1;
  return (request: SearchWorkerRequest) => {
    if (!request || !request.marker || request.marker.policyVersion !== SEARCH_POLICY_VERSION
      || typeof request.marker.generation !== 'string' || !Number.isSafeInteger(request.marker.dataSeq) || request.marker.dataSeq < 0) {
      post({ type: 'error', message: 'Invalid search index version. Rebuild the index from the library.' });
      return;
    }
    if (request.type === 'build') {
      if (!Number.isSafeInteger(request.buildId) || request.buildId <= latestBuild) return;
      latestBuild = request.buildId;
      index = undefined; marker = undefined;
      try {
        if (!Array.isArray(request.documents)) throw new Error('Invalid documents.');
        index = createKnowledgeIndex(request.documents);
        marker = { ...request.marker };
        post({ type: 'ready', buildId: request.buildId, marker });
      } catch {
        // Do not report document content or retain an older index on failure.
        post({ type: 'error', message: 'The search index could not be built. Reload it from the library.' });
      }
    } else if (request.type === 'search') {
      if (!Number.isSafeInteger(request.queryId) || request.queryId <= latestQuery || typeof request.query !== 'string') return;
      latestQuery = request.queryId;
      if (!index || !sameSearchMarker(marker, request.marker)) {
        post({ type: 'results', queryId: request.queryId, marker: request.marker,
          result: { hits: [], total: 0, error: 'The library changed. Rebuild the search index.' } });
        return;
      }
      try {
        post({ type: 'results', queryId: request.queryId, marker: request.marker, result: index.search(request.query, request.options) });
      } catch {
        index = undefined; marker = undefined;
        post({ type: 'results', queryId: request.queryId, marker: request.marker,
          result: { hits: [], total: 0, error: 'The search index failed. Reload it from the library.' } });
      }
    }
  };
}
