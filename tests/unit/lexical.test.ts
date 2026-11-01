import { describe, expect, it } from 'vitest';
import { createProbeIndex, tokenize } from '../../src/search/lexical';

describe('lexical feasibility', () => {
  const index = createProbeIndex();
  it.each(['HT-928', 'client.retry.count', '/etc/pine/config.toml', '--dry-run'])('retains the whole technical identifier %s', query => {
    expect(tokenize(query)).toContain(query.toLowerCase());
    expect(index.search(query)[0]?.id).toBe('retry');
  });
  it.each(['费曼', '学习方法', '中文'])('retrieves Chinese %s', query => {
    expect(index.search(query).length).toBeGreaterThan(0);
  });
  it('ANDs separate user terms, not generated aliases, with honest no-match', () => {
    expect(index.search('HT-928 --dry-run').map(note => note.id)).toEqual(['retry']);
    expect(index.search('HT-928 unrelated')).toEqual([]);
    expect(index.search('')).toEqual([]);
    expect(index.search('???')).toEqual([]);
  });
  it('never modifies supplied source text while indexing', () => {
    const note = { id: 'code', title: 'Sample', body: '\tconst café = "🧠";\n    return café;\n' };
    const original = JSON.stringify(note);
    createProbeIndex([note]).search('café');
    expect(JSON.stringify(note)).toBe(original);
  });
});
