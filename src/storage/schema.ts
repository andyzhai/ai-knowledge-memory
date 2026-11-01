import Dexie, { type Table } from 'dexie';
import type { KnowledgeItem, KnowledgeRevision, LibraryMeta, RequestReceipt } from '../shared/knowledge';
import type { Connection, Conversation, Message, MessageRevision, Capture, SourceRef } from '../shared/archive';

// Nullable compound keys are intentionally not indexed by IndexedDB. A2 must
// validate each reference and only assign a sourceMessageId for known identity.
export const STORES = {
  connections: 'id,&provider',
  conversations: 'id,&[connectionId+identityKey],updatedAt',
  messages: 'id,&[conversationId+sourceMessageId],conversationId',
  messageRevisions: 'id,&[messageId+contentHash],messageId',
  captures: 'id,conversationId,capturedAt,requestId',
  knowledgeItems: 'id,&curationKey,reviewState,type,*tags,updatedAt',
  sourceRefs: 'id,knowledgeId,conversationId,revisionId,captureId',
  knowledgeRevisions: 'id,&[knowledgeId+version],knowledgeId',
  meta: 'id',
  requestReceipts: 'requestId,createdAt,expiresAt',
};
export function databaseName(generation: string): string { return `akm-library-${generation}`; }
export class KnowledgeDatabase extends Dexie {
  connections!: Table<Connection, string>;
  conversations!: Table<Conversation, string>;
  messages!: Table<Message, string>;
  messageRevisions!: Table<MessageRevision, string>;
  captures!: Table<Capture, string>;
  sourceRefs!: Table<SourceRef, string>;
  knowledgeItems!: Table<KnowledgeItem, string>;
  knowledgeRevisions!: Table<KnowledgeRevision, string>;
  meta!: Table<LibraryMeta, string>;
  requestReceipts!: Table<RequestReceipt, string>;
  constructor(generation: string) {
    super(databaseName(generation), { chromeTransactionDurability: 'strict', cache: 'disabled', addons: [] });
    this.version(1).stores(STORES);
    this.on('populate', tx => tx.table('meta').add({
      id: 'library', schemaVersion: 1, libraryId: crypto.randomUUID(), generation,
      dataSeq: 0, status: 'ready', writeFence: null,
    } satisfies LibraryMeta));
    this.on('versionchange', () => this.close());
  }
}
