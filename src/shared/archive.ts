// Immutable source evidence; observation and recovery state belong to captures.
import { digest, fail, type Common } from './knowledge';
export type Provider = 'chatgpt' | 'gemini' | 'perplexity';
export type Scope = 'message' | 'excerpt';
export type Role = 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
export type Completion = 'complete' | 'partial' | 'unknown';
export type Block =
  | { kind: 'text' | 'paragraph' | 'quote' | 'math' | 'unsupported'; text: string }
  | { kind: 'heading'; text: string; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: 'code'; text: string; language: string | null }
  | { kind: 'list'; text: string; ordered: boolean }
  | { kind: 'table'; text: string; rows: string[][] }
  | { kind: 'link' | 'citation'; text: string; url: string | null };
export type Anchor = { quote: string; start: number; end: number; extractorVersion: string };
export type Connection = Common & { provider: Provider; namespace: string; enabled: boolean; capturePolicy: 'manual'; accountRef: null };
export type Conversation = Common & {
  connectionId: string; identityKey: string; identityQuality: 'provider' | 'url' | 'session';
  canonicalUrl: string | null; title: string; sourceKind: 'captured' | 'pasted';
  providerConversationId: string | null; latestCaptureId: string | null; lastCapturedAt: string;
  temporaryStatus: 'temporary' | 'ordinary' | 'unknown';
  createdByRequestId?: string;
};
export type Message = Common & {
  conversationId: string; sourceMessageId: string | null; identityQuality: 'provider' | 'matched' | 'unknown';
  contentScope: Scope; originMessageLocator: string | null; latestObservedRevisionId: string | null;
  createdByRequestId?: string; independentlyRetained?: boolean;
};
export type MessageRevision = {
  id: string; schemaVersion: 1; messageId: string; role: Role; contentScope: Scope; blocks: Block[];
  plainText: string; contentHash: string; canonicalVersion: 1; observedAt: string; completion: Completion; extractorVersion: string;
  sourceCreatedAt: string | null; language: string | null; parentSourceMessageId: string | null;
};
// Observation metadata is on membership so identical partial/complete text can
// share an immutable revision without losing either observed completion state.
export type CaptureMembership = { revisionId: string; completion: Completion; observedAt: string; extractorVersion: string };
export type Capture = Common & {
  conversationId: string; revisionIds: string[]; membership: CaptureMembership[]; scope: 'selection' | 'loaded_conversation';
  historyCoverage: 'loaded_only' | 'unknown'; branchCoverage: 'visible_branch' | 'unknown'; warnings: string[];
  capturedAt: string; adapterVersion: string; captureStatus: 'in_progress' | 'completed' | 'interrupted';
  requestId: string; createdByRequestId: string; independentlyRetained: boolean;
  sessionId: string; nextExpectedBatch: number; acceptedBatches: { number: number; hash: string; revisionIds: string[] }[];
  declaredTotals: { batches: number; messages: number } | null; navigationNonceDigest: string | null;
  owner?: import('./curation').CurationOwner;
  providerEpoch?: string;
  startDigest?: string;
  issuedAt?: string;
  branchObservation?: { messageIds: (string | null)[]; signature: string };
  interruptionReason?: string;
};
export type SourceRef = {
  id: string; schemaVersion: 1; knowledgeId: string; sourceKind: 'captured' | 'pasted'; exactText: string;
  sourceProvider: Provider | null; sourceTitle: string; capturedAt: string; sourceUrl: string | null;
  conversationId: string | null; captureId: string | null; revisionId: string | null;
  anchorStatus: 'resolved' | 'unresolved' | 'ambiguous'; anchor: Anchor | null;
  originalPageAnchor: (Anchor & { locator: string | null; prefix: string; suffix: string }) | null;
  fidelityWarnings: string[]; sourceContentHash: string | null; sourceRemovedAt: string | null;
  fragmentOrder?: number; sourceRole?: Role; contentScope?: Scope; blockKind?: 'text' | 'code'; temporaryStatus?: 'temporary' | 'unknown';
};
export function validAnchor(text: string, anchor: Anchor): boolean {
  const points = Array.from(text);
  return Number.isSafeInteger(anchor.start) && Number.isSafeInteger(anchor.end) && anchor.start >= 0 &&
    anchor.end > anchor.start && anchor.end <= points.length && points.slice(anchor.start, anchor.end).join('') === anchor.quote && !!anchor.extractorVersion;
}
export function sourceHash(scope: Scope, role: Role, blocks: Block[]): Promise<string> {
  if (!['message', 'excerpt'].includes(scope) || !['user', 'assistant', 'system', 'tool', 'unknown'].includes(role)) fail('INVALID_COMMAND');
  return digest({ scope, role, blocks });
}
