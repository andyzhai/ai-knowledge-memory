import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchSession, type SearchView } from '../../src/ui/SearchSession';
import type { SearchWorkerRequest, SearchWorkerReply } from '../../src/shared/search';
import type { SearchReadReply } from '../../src/shared/search-access';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function harness() {
  vi.useFakeTimers();
  const marker = { generation: crypto.randomUUID(), dataSeq: 1 };
  const requests: SearchWorkerRequest[] = [];
  const views: SearchView[] = [];
  const send = vi.fn(async (command: { type: string }) => command.type === 'GetSearchState'
    ? { ok: true, marker, total: 0 }
    : { ok: true, marker, documents: [], nextId: null });
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path, sendMessage: send } });
  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: SearchWorkerReply }) => void;
    terminate() {}
    postMessage(request: SearchWorkerRequest) {
      requests.push(request);
      this.onmessage?.({ data: request.type === 'build'
        ? { type: 'ready', buildId: request.buildId, marker: request.marker }
        : { type: 'results', queryId: request.queryId, marker: request.marker, result: { hits: [], total: 0 } } });
    }
  });
  const session = new SearchSession(view => views.push(view));
  return { session, requests, views, send, marker };
}
describe('UI-owned search lifecycle', () => {
  it('invalidates displayed results immediately but debounces rapid typing for 75ms', async () => {
    const { session, requests, views } = harness(); await session.rebuild(); await vi.advanceTimersByTimeAsync(0);
    requests.length = 0;
    session.update('oldtoken', {}); session.update('newtoken', {});
    expect(views.at(-1)?.phase).toBe('loading');
    await vi.advanceTimersByTimeAsync(74); expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ type: 'search', query: 'newtoken' });
    session.update('disposed', {}); session.dispose(); await vi.advanceTimersByTimeAsync(100);
    expect(requests).toHaveLength(1);
  });
  it('ignores an older focus reconciliation failure after a successful newer rebuild', async () => {
    const { session, views, send } = harness(); await session.rebuild(); await vi.advanceTimersByTimeAsync(0);
    let finish!: (reply: SearchReadReply) => void;
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    const stale = session.reconcile(); await session.rebuild(); await vi.advanceTimersByTimeAsync(0);
    expect(views.at(-1)?.phase).toBe('ready');
    finish({ ok: false, code: 'STORAGE_UNAVAILABLE', message: 'older failure', retryable: true }); await stale;
    expect(views.at(-1)?.phase).toBe('ready'); session.dispose();
  });
  it('ignores an older focus error after a new query on the same index', async () => {
    const { session, views, send } = harness(); await session.rebuild(); await vi.advanceTimersByTimeAsync(0);
    let finish!: (reply: SearchReadReply) => void;
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    const stale = session.reconcile(); session.update('newtoken', {}); await vi.advanceTimersByTimeAsync(75);
    expect(views.at(-1)?.phase).toBe('ready');
    finish({ ok: false, code: 'STORAGE_UNAVAILABLE', message: 'older failure', retryable: true }); await stale;
    expect(views.at(-1)?.phase).toBe('ready'); session.dispose();
  });
});
