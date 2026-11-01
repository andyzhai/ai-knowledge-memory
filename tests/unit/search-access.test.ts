import { describe, expect, it } from 'vitest';
import { parseSearchReadCommand, sameCanonicalMarker } from '../../src/shared/search-access';

describe('bounded canonical search reads', () => {
  const marker = { generation: crypto.randomUUID(), dataSeq: 12 };
  it('accepts only explicit, bounded read commands', () => {
    expect(parseSearchReadCommand({ protocolVersion: 1, type: 'GetSearchState' })).not.toBeNull();
    expect(parseSearchReadCommand({ protocolVersion: 1, type: 'ReadSearchPage', marker, afterId: null })).not.toBeNull();
    expect(parseSearchReadCommand({ protocolVersion: 1, type: 'HydrateSearchResults', marker, ids: [] })).not.toBeNull();
    for (const value of [
      { protocolVersion: 2, type: 'GetSearchState' },
      { protocolVersion: 1, type: 'GetSearchState', collection: 'archive' },
      { protocolVersion: 1, type: 'ReadSearchPage', marker: { ...marker, dataSeq: -1 }, afterId: null },
      { protocolVersion: 1, type: 'ReadSearchPage', marker: { ...marker, generation: 'wrong' }, afterId: null },
      { protocolVersion: 1, type: 'ReadSearchPage', marker, afterId: '../file' },
      { protocolVersion: 1, type: 'HydrateSearchResults', marker, ids: new Array(9).fill(null).map(() => crypto.randomUUID()) },
      { protocolVersion: 1, type: 'HydrateSearchResults', marker, ids: [marker.generation, marker.generation] },
    ]) expect(parseSearchReadCommand(value)).toBeNull();
  });
  it('uses generation as well as sequence to identify current canonical data', () => {
    expect(sameCanonicalMarker(marker, { ...marker })).toBe(true);
    expect(sameCanonicalMarker(marker, { ...marker, generation: crypto.randomUUID() })).toBe(false);
    expect(sameCanonicalMarker(marker, { ...marker, dataSeq: 13 })).toBe(false);
    expect(sameCanonicalMarker(marker, undefined)).toBe(false);
  });
});
