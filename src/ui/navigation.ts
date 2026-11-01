import { useEffect, useRef, useState } from 'react';
import { isId } from '../shared/knowledge';

export type Destination = 'knowledge' | 'archive' | 'settings';
export type LibraryLocation = { destination: Destination; noteId?: string; captureId?: string; revisionId?: string };
export type NavigationGuard = (next: LibraryLocation, proceed: () => void) => boolean;

export function readLocation(search: string): LibraryLocation {
  const params = new URLSearchParams(search);
  const noteId = params.get('note'), captureId = params.get('capture'), revisionId = params.get('revision');
  if (isId(noteId)) return { destination: 'knowledge', noteId };
  if (isId(captureId)) return { destination: 'archive', captureId, ...(isId(revisionId) ? { revisionId } : {}) };
  const view = params.get('view');
  return { destination: view === 'archive' || view === 'settings' ? view : 'knowledge' };
}

export function locationHref(next: LibraryLocation, href = location.href): string {
  const url = new URL(href);
  for (const key of ['view', 'note', 'capture', 'revision']) url.searchParams.delete(key);
  if (next.destination === 'knowledge' && next.noteId) url.searchParams.set('note', next.noteId);
  else if (next.destination === 'archive' && next.captureId) {
    url.searchParams.set('capture', next.captureId);
    if (next.revisionId) url.searchParams.set('revision', next.revisionId);
  } else if (next.destination !== 'knowledge') url.searchParams.set('view', next.destination);
  url.hash = '';
  return url.href;
}

export function useLibraryNavigation() {
  const [current, setCurrent] = useState(() => readLocation(location.search));
  const remembered = useRef<Record<Destination, LibraryLocation>>({
    knowledge: { destination: 'knowledge' }, archive: { destination: 'archive' }, settings: { destination: 'settings' },
  });
  remembered.current[current.destination] = current;
  const currentRef = useRef(current); currentRef.current = current;
  const guard = useRef<NavigationGuard | undefined>(undefined);
  const position = useRef(0);
  const reverting = useRef<(() => void) | undefined>(undefined);
  const approvedPop = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    position.current = history.state?.libraryPosition ?? 0;
    history.replaceState({ ...history.state, libraryPosition: position.current }, '');
    const pop = () => {
      if (reverting.current) { const done = reverting.current; reverting.current = undefined; done(); return; }
      const next = readLocation(location.search);
      const targetPosition = history.state?.libraryPosition ?? 0;
      const delta = targetPosition - position.current;
      if (approvedPop.current) {
        approvedPop.current = false; position.current = targetPosition; setCurrent(next); return;
      }
      if (delta && guard.current?.(next, () => {
        const accept = () => { approvedPop.current = true; history.go(delta); };
        if (reverting.current) reverting.current = accept; else accept();
      })) {
        // Restore the current entry before the user resolves the draft. Accepting
        // later traverses the original entry, preserving native Back/Forward.
        reverting.current = () => undefined;
        history.go(-delta); return;
      }
      position.current = targetPosition; setCurrent(next);
    };
    window.addEventListener('popstate', pop);
    return () => { mounted.current = false; window.removeEventListener('popstate', pop); };
  }, []);
  function navigate(next: LibraryLocation, replace = false, approved = false) {
    if (!mounted.current) return;
    if (!approved && guard.current?.(next, () => navigate(next, replace, true))) return;
    const href = locationHref(next);
    if (href !== location.href) {
      if (!replace) position.current++;
      history[replace ? 'replaceState' : 'pushState']({ libraryPosition: position.current }, '', href);
    }
    setCurrent(next);
  }
  function selectNote(noteId?: string, replace = false) {
    if (!mounted.current) return;
    const next: LibraryLocation = { destination: 'knowledge', ...(noteId ? { noteId } : {}) };
    // A save completing in a hidden editor must not pull the user out of Settings.
    if (currentRef.current.destination === 'knowledge') navigate(next, replace);
    else { remembered.current.knowledge = next; setCurrent({ ...currentRef.current }); }
  }
  return { current, remembered: remembered.current, navigate, selectNote, guard };
}
