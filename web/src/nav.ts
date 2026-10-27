import { useLocation } from 'wouter';
import { personRequest } from './store.ts';
import type { RowKey } from './rows.ts';

/** Open a title over the current tab; closing returns to exactly where you were. */
export function useOpenTitle() {
  const [, navigate] = useLocation();
  return (id: number) => navigate(`/title/${id}`, { state: { fromApp: true } });
}

/** Open the page of a film that isn't on the NAS (TMDB movie id), over the current tab. */
export function useOpenFilm() {
  const [, navigate] = useLocation();
  return (tmdbId: number) => navigate(`/film/${tmdbId}`, { state: { fromApp: true } });
}

/** Open a film set (TMDB collection name) over the library. */
export function useOpenSet() {
  const [, navigate] = useLocation();
  return (key: string) => navigate(`/set/${encodeURIComponent(key)}`, { state: { fromApp: true } });
}

/** Open the page of all the titles of a row above the library. */
export function useOpenRow() {
  const [, navigate] = useLocation();
  return (row: RowKey) => navigate(`/row/${row}`, { state: { fromApp: true } });
}

/** The library, showing only the titles of one actor or director. Back returns to the page. */
export function useShowPerson() {
  const [, navigate] = useLocation();
  return (name: string) => {
    personRequest.set(name);
    navigate('/');
  };
}
