import type { Block, Capture, Completion, MessageRevision, Role } from './archive';
import { exactKeys, isId, isIso, type LibraryReply } from './knowledge';
import { canonicalRoute } from './protocol';

export const LOADED_EXTRACTOR = 'a4-visible-blocks-2';
export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_LOADED_MESSAGES = 2000;
export type LoadedMessage = { sourceMessageId: string | null; role: Role; blocks: Block[]; completion: Completion; observedAt: string };
export type LoadedPlan = {
  title: string; temporaryStatus: 'temporary' | 'unknown'; warnings: string[];
  messageIds: (string | null)[]; batches: number; messages: number;
};
export type CaptureEnvelope = {
  protocolVersion: 1; generation: string; providerEpoch: string; sessionId: string;
  route: string; nonce: string; issuedAt: string;
};
export type CaptureCommand =
  | { protocolVersion: 1; type: 'BeginLoadedCapture'; route: string; nonce: string }
  | CaptureEnvelope & ({ type: 'StartArchiveCapture'; plan: LoadedPlan }
    | { type: 'ArchiveCaptureBatch'; number: number; messages: LoadedMessage[] }
    | { type: 'ArchiveCaptureStatus' | 'FinishArchiveCapture' | 'InterruptArchiveCapture' });
export type CaptureProgress = { generation: string; dataSeq: number; captureId: string; status: Capture['captureStatus']; nextExpectedBatch: number; committedMessages: number };
export type CaptureReply = { ok: true; progress: CaptureProgress } | { ok: true; generation: string; providerEpoch: string } | Extract<LibraryReply, { ok: false }>;
export type ArchiveOpen = { protocolVersion: 1; type: 'OpenArchiveCapture'; generation: string; captureId: string };
export type ArchiveSummary = Pick<Capture, 'id' | 'conversationId' | 'capturedAt' | 'captureStatus' | 'scope' | 'warnings'> & { title: string; messages: number };
export type ArchiveDetail = { capture: Capture; title: string; url: string | null; revisions: MessageRevision[]; offset: number };
export type ArchiveRead = { protocolVersion: 1; type: 'ListArchiveCaptures'; offset: number; conversationId: string | null }
  | { protocolVersion: 1; type: 'GetArchiveCapture'; generation: string; captureId: string; offset: number };
export type ArchiveReply = { ok: true; generation: string; captures: ArchiveSummary[]; total: number }
  | { ok: true; generation: string; detail: ArchiveDetail } | Extract<LibraryReply, { ok: false }>;
const bounded = (v: unknown, n: number): v is string => typeof v === 'string' && v.isWellFormed() && v.length <= n;
const locator = (v: unknown) => v === null || (bounded(v, 256) && /^[\w-]+$/.test(v));
const count = (v: unknown, max: number) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
export function validBlock(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (!bounded(b.text, MAX_BATCH_BYTES)) return false;
  if (['text', 'paragraph', 'quote', 'math', 'unsupported'].includes(b.kind as string)) return exactKeys(b, ['kind', 'text']);
  if (b.kind === 'code') return exactKeys(b, ['kind', 'text', 'language']) && (b.language === null || bounded(b.language, 100));
  if (b.kind === 'heading') return exactKeys(b, ['kind', 'text', 'level']) && count(b.level, 6) && b.level !== 0;
  if (b.kind === 'list') return exactKeys(b, ['kind', 'text', 'ordered']) && typeof b.ordered === 'boolean';
  if (b.kind === 'table') return exactKeys(b, ['kind', 'text', 'rows']) && Array.isArray(b.rows) && b.rows.length <= 500 && b.rows.every(row => Array.isArray(row) && row.length <= 100 && row.every(cell => bounded(cell, MAX_BATCH_BYTES)));
  if (b.kind === 'link' || b.kind === 'citation') return exactKeys(b, ['kind', 'text', 'url']) && (b.url === null || (bounded(b.url, 2048) && /^https?:\/\//.test(b.url)));
  return false;
}
export function validLoadedMessage(v: unknown): v is LoadedMessage {
  return exactKeys(v, ['sourceMessageId', 'role', 'blocks', 'completion', 'observedAt']) && locator(v.sourceMessageId) &&
    ['user', 'assistant', 'system', 'tool', 'unknown'].includes(v.role as string) && ['complete', 'partial', 'unknown'].includes(v.completion as string) && isIso(v.observedAt) &&
    Array.isArray(v.blocks) && v.blocks.length > 0 && v.blocks.length <= 2048 && v.blocks.every(validBlock);
}
export function parseCaptureCommand(v: unknown): CaptureCommand | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (c.protocolVersion !== 1 || !bounded(c.route, 2048) || canonicalRoute(c.route) !== c.route || !isId(c.nonce)) return null;
  if (c.type === 'BeginLoadedCapture' && exactKeys(c, ['protocolVersion', 'type', 'route', 'nonce'])) return c as CaptureCommand;
  const keys = ['protocolVersion', 'type', 'generation', 'providerEpoch', 'sessionId', 'route', 'nonce', 'issuedAt'];
  if (!isId(c.generation) || !isId(c.providerEpoch) || !isId(c.sessionId) || !isIso(c.issuedAt)) return null;
  if (['ArchiveCaptureStatus', 'FinishArchiveCapture', 'InterruptArchiveCapture'].includes(c.type as string) && exactKeys(c, keys)) return c as CaptureCommand;
  if (c.type === 'StartArchiveCapture' && exactKeys(c, [...keys, 'plan'])) {
    const p = c.plan;
    if (exactKeys(p, ['title', 'temporaryStatus', 'warnings', 'messageIds', 'batches', 'messages']) && bounded(p.title, 1000) &&
      ['temporary', 'unknown'].includes(p.temporaryStatus as string) && Array.isArray(p.warnings) && p.warnings.length <= 64 && p.warnings.every(w => bounded(w, 100) && /^[a-z_]+$/.test(w)) &&
      count(p.messages, MAX_LOADED_MESSAGES) && (p.messages as number) > 0 && count(p.batches, p.messages as number) && (p.batches as number) > 0 &&
      Array.isArray(p.messageIds) && p.messageIds.length === p.messages && p.messageIds.every(locator) && new Set(p.messageIds.filter(id => id !== null)).size === p.messageIds.filter(id => id !== null).length) return c as CaptureCommand;
  }
  if (c.type === 'ArchiveCaptureBatch' && exactKeys(c, [...keys, 'number', 'messages']) && count(c.number, MAX_LOADED_MESSAGES - 1) &&
    Array.isArray(c.messages) && c.messages.length > 0 && c.messages.length <= 8 && c.messages.every(validLoadedMessage) && new TextEncoder().encode(JSON.stringify(c)).length <= MAX_BATCH_BYTES) return c as CaptureCommand;
  return null;
}
export function parseArchiveRead(v: unknown): ArchiveRead | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (c.protocolVersion !== 1 || !count(c.offset, 1_000_000)) return null;
  if (c.type === 'ListArchiveCaptures' && exactKeys(c, ['protocolVersion', 'type', 'offset', 'conversationId']) && (c.conversationId === null || isId(c.conversationId))) return c as ArchiveRead;
  if (c.type === 'GetArchiveCapture' && exactKeys(c, ['protocolVersion', 'type', 'generation', 'captureId', 'offset']) && isId(c.generation) && isId(c.captureId)) return c as ArchiveRead;
  return null;
}
export function parseArchiveOpen(v: unknown): ArchiveOpen | null {
  return exactKeys(v, ['protocolVersion', 'type', 'generation', 'captureId']) && v.protocolVersion === 1 && v.type === 'OpenArchiveCapture' &&
    isId(v.generation) && isId(v.captureId) ? v as ArchiveOpen : null;
}
