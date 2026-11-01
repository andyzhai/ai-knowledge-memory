import { fail } from '../shared/knowledge';
import type { SearchReadCommand, SearchReadReply } from '../shared/search-access';
import type { SearchDocument } from '../shared/search';
import type { KnowledgeRepository } from './repository';
import { readArchiveSearch } from './archive-search';

// Read-only repository boundary. Archive tables are deliberately not loaded.
export async function readSearch(repo: KnowledgeRepository, command: SearchReadCommand): Promise<SearchReadReply> {
  if (command.type.includes('Archive')) return readArchiveSearch(repo, command);
  return repo.db.transaction('r', [repo.db.meta, repo.db.knowledgeItems, repo.db.sourceRefs], async () => {
    const meta = await repo.checkReady();
    const marker = { generation: repo.generation, dataSeq: meta.dataSeq };
    if (command.type === 'GetSearchState') return { ok: true, marker, total: await repo.db.knowledgeItems.count() };
    if (!('marker' in command) || command.marker.generation !== marker.generation || command.marker.dataSeq !== marker.dataSeq) fail('SEARCH_CHANGED');
    const notes = 'ids' in command
      ? (await repo.db.knowledgeItems.bulkGet(command.ids)).filter(note => note !== undefined)
      : await (command.afterId ? repo.db.knowledgeItems.where('id').above(command.afterId) : repo.db.knowledgeItems.orderBy('id')).limit(32).toArray();
    const documents: SearchDocument[] = [];
    let bytes = 0;
    for (const note of notes) {
      const sources = await repo.db.sourceRefs.where('knowledgeId').equals(note.id).toArray();
      const providers = [...new Set(sources.filter(source => source.sourceProvider).map(source => source.sourceProvider!))];
      const document: SearchDocument = { note, providers: note.sourceKind === 'manual' ? ['manual', ...providers] : providers };
      const size = new TextEncoder().encode(JSON.stringify(document)).length;
      if (command.type === 'ReadSearchPage' && documents.length && bytes + size > 1024 * 1024) break;
      documents.push(document); bytes += size;
    }
    return { ok: true, marker, documents, nextId: command.type === 'ReadSearchPage' && documents.length ? documents.at(-1)!.note.id : null };
  });
}
