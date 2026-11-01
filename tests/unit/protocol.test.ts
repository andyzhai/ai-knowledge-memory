import { describe, expect, it } from 'vitest';
import { canonicalRoute, conversationIdentity, parseCommand } from '../../src/shared/protocol';
import { codePointOffset } from '../../src/capture/selection';

describe('capture boundary', () => {
  it('accepts only canonical ordinary and Project ChatGPT conversation paths', () => {
    expect(canonicalRoute('https://chatgpt.com/c/abc-123?utm_source=test#unsafe')).toBe('https://chatgpt.com/c/abc-123');
    expect(canonicalRoute('https://chatgpt.com/g/g-p-68f15f42c0c48191aff3d6cb47c231e0-other-tech-misc/c/abc-123')).toBe('https://chatgpt.com/g/g-p-68f15f42c0c48191aff3d6cb47c231e0-other-tech-misc/c/abc-123');
    expect(canonicalRoute('https://chatgpt.com/g/g-p-abc/c/abc-123/')).toBe('https://chatgpt.com/g/g-p-abc/c/abc-123');
    expect(canonicalRoute('https://chatgpt.com/c/abc-123/')).toBe('https://chatgpt.com/c/abc-123');
    for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/auth/login', 'https://chatgpt.com/g/g-p-abc', 'https://chatgpt.com/g/', 'https://chatgpt.com.evil.test/c/a', 'http://chatgpt.com/c/a', 'javascript:alert(1)', 'https://gemini.google.com/c/a', 'https://chatgpt.com/c/foo/bar', 'https://chatgpt.com/g/p/c/foo/bar']) {
      expect(conversationIdentity(url)).toBeNull();
    }
  });
  it('extracts the same conversation identity from /c/ and /g/ routes', () => {
    expect(conversationIdentity('https://chatgpt.com/c/6ad03080-e288-83ea-80ac-0c68945f2dce')).toBe('6ad03080-e288-83ea-80ac-0c68945f2dce');
    expect(conversationIdentity('https://chatgpt.com/g/g-p-68f15f42c0c48191aff3d6cb47c231e0-other-tech-misc/c/6ad03080-e288-83ea-80ac-0c68945f2dce')).toBe('6ad03080-e288-83ea-80ac-0c68945f2dce');
    expect(conversationIdentity('https://chatgpt.com/g/g-p-abc/c/test-conv?share=xyz')).toBe('test-conv');
  });
  it('rejects unknown fields, protocols, commands and unbounded route values', () => {
    expect(parseCommand({ type: 'GetStatus', protocolVersion: 1 })).not.toBeNull();
    for (const value of [null, [], { type: 'ExportLibrary', protocolVersion: 1 }, { type: 'GetStatus', protocolVersion: 2 }, { type: 'GetStatus', protocolVersion: 1, text: 'not allowed' }, { type: 'SetProviderEnabled', protocolVersion: 1, enabled: 'true' }, { type: 'AuthorizePreview', protocolVersion: 1, route: 'a'.repeat(2049) }]) {
      expect(parseCommand(value)).toBeNull();
    }
  });
  it('converts UTF-16 offsets without splitting surrogate pairs or altering Chinese', () => {
    expect(codePointOffset('A🧠中文', 3)).toBe(2);
    expect(codePointOffset('A🧠中文', 5)).toBe(4);
    expect(() => codePointOffset('A🧠中文', 2)).toThrow('SPLIT_SURROGATE');
    expect(() => codePointOffset('abc', 4)).toThrow('INVALID_OFFSET');
  });
});
