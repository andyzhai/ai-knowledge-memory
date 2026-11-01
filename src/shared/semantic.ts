import model from '../search/model-manifest.json' with { type: 'json' };
import type { SearchDocument, SearchMarker, SearchOptions, SearchResult } from './search';

export const EMBEDDING_SIGNATURE = JSON.stringify({ model: model.id, revision: model.revision,
  assets: model.files.map(file => file.sha256), dimensions: model.dimensions, runtime: model.runtime,
  tokenizer: 'pinned-bert', chunker: 'fields-paragraph-lines-token128-v1', preprocessing: 'canonical-fields-v1',
  pooling: 'attention-mask-mean', normalization: 'l2', queryPrefix: '', documentPrefix: '', dtype: 'q8' });
export type SemanticRequest =
  | { type: 'build'; buildId: number; marker: SearchMarker; signature: string; documents: SearchDocument[] }
  | { type: 'search'; queryId: number; marker: SearchMarker; signature: string; query: string; options: SearchOptions };
export type SemanticReply =
  | { type: 'ready'; buildId: number; marker: SearchMarker; signature: string; chunks: number; elapsedMs: number }
  | { type: 'results'; queryId: number; marker: SearchMarker; signature: string; result: SearchResult; elapsedMs: number }
  | { type: 'error'; message: string };
export interface EmbeddingProvider {
  signature: string;
  dimensions: number;
  tokenCount(text: string): number;
  embed(text: string): Promise<number[]>;
}
