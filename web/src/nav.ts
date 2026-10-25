import { useLocation } from 'wouter';

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
