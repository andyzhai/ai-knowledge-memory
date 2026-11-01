import type { SearchWorkerRequest } from '../shared/search';
import { createSearchWorkerHandler } from './worker-state';

const receive = createSearchWorkerHandler(reply => self.postMessage(reply));
self.onmessage = (event: MessageEvent<SearchWorkerRequest>) => receive(event.data);
