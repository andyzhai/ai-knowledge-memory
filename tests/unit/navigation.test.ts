import { describe, expect, it } from 'vitest';
import { locationHref, readLocation } from '../../src/ui/navigation';

const noteId = '10000000-0000-4000-8000-000000000001';
const captureId = '20000000-0000-4000-8000-000000000002';
describe('library locations', () => {
  it('defaults to Knowledge and validates detail IDs before choosing a destination', () => {
    expect(readLocation('')).toEqual({ destination: 'knowledge' });
    expect(readLocation('?view=unknown&note=invalid')).toEqual({ destination: 'knowledge' });
    expect(readLocation('?view=settings')).toEqual({ destination: 'settings' });
    expect(readLocation('?view=archive')).toEqual({ destination: 'archive' });
    expect(readLocation(`?view=settings&note=${noteId}`)).toEqual({ destination: 'knowledge', noteId });
    expect(readLocation(`?capture=${captureId}&revision=invalid`)).toEqual({ destination: 'archive', captureId });
  });
  it('round-trips detail links and removes conflicting destination parameters', () => {
    const base = `chrome-extension://example/library.html?note=${noteId}&previewError=PERMISSION_DENIED#old`;
    const next = { destination: 'archive' as const, captureId, revisionId: noteId };
    const url = new URL(locationHref(next, base));
    expect(readLocation(url.search)).toEqual(next);
    expect(url.searchParams.has('note')).toBe(false);
    expect(url.searchParams.get('previewError')).toBe('PERMISSION_DENIED');
    expect(url.hash).toBe('');
    expect(locationHref({ destination: 'settings' }, url.href)).toBe('chrome-extension://example/library.html?previewError=PERMISSION_DENIED&view=settings');
  });
});
