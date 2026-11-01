import { describe, expect, it } from 'vitest';
import { MAX_BATCH_BYTES, parseCaptureCommand, parseArchiveRead, type CaptureEnvelope, type LoadedMessage } from '../../src/shared/loaded-capture';

const envelope: CaptureEnvelope = { protocolVersion: 1, generation: crypto.randomUUID(), providerEpoch: crypto.randomUUID(), sessionId: crypto.randomUUID(), route: 'https://chatgpt.com/c/test', nonce: crypto.randomUUID(), issuedAt: new Date().toISOString() };
const message: LoadedMessage = { sourceMessageId: 'a1', role: 'assistant', blocks: [{ kind: 'code', text: '\t字🧠  \n', language: null }], completion: 'unknown', observedAt: envelope.issuedAt };
describe('loaded capture transport', () => {
  it('accepts bounded, versioned explicit commands and rejects malformed batches without truncation', () => {
    const batch = { ...envelope, type: 'ArchiveCaptureBatch', number: 0, messages: [message] };
    expect(parseCaptureCommand(batch)).not.toBeNull();
    for (const invalid of [
      { ...batch, messages: [] }, { ...batch, messages: Array(9).fill(message) }, { ...batch, number: -1 },
      { ...batch, generation: 'bad' }, { ...batch, unexpected: true }, { ...batch, route: 'https://evil.test/c/test' },
      { ...batch, messages: [{ ...message, completion: 'quiet' }] }, { ...batch, messages: [{ ...message, blocks: [{ kind: 'html', text: '<script/>' }] }] },
      { ...batch, messages: [{ ...message, blocks: [{ kind: 'code', text: 'a'.repeat(MAX_BATCH_BYTES), language: null }] }] },
    ]) expect(parseCaptureCommand(invalid)).toBeNull();
  });
  it('requires declared ordered identity membership and bounded read pagination', () => {
    const start = { ...envelope, type: 'StartArchiveCapture', plan: { title: 'x', messages: 2, batches: 1, messageIds: ['a1', 'a2'], warnings: [], temporaryStatus: 'unknown' } };
    expect(parseCaptureCommand(start)).not.toBeNull();
    expect(parseCaptureCommand({ ...start, plan: { ...start.plan, messageIds: ['a1', 'a1'] } })).toBeNull();
    expect(parseCaptureCommand({ ...start, plan: { ...start.plan, messageIds: [null, null] } })).not.toBeNull();
    expect(parseCaptureCommand({ ...start, plan: { ...start.plan, batches: 0 } })).toBeNull();
    expect(parseArchiveRead({ protocolVersion: 1, type: 'GetArchiveCapture', generation: envelope.generation, captureId: envelope.sessionId, offset: 0 })).not.toBeNull();
    expect(parseArchiveRead({ protocolVersion: 1, type: 'ListArchiveCaptures', conversationId: null, offset: -1 })).toBeNull();
  });
});
