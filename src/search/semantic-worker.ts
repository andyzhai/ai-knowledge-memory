import { loadEmbeddingProvider } from './embedding-provider';
import { createSemanticWorkerHandler } from './semantic-worker-state';

const handle = createSemanticWorkerHandler(loadEmbeddingProvider, reply => postMessage(reply));
self.onmessage = event => { void handle(event.data); };
