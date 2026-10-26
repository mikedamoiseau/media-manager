/** This device's TV: the one it picked, else the first (also when the one it picked was removed). */
export function chosenTv<T extends { id: string }>(tvs: T[], id: string | null): T | null {
  return tvs.find((t) => t.id === id) ?? tvs[0] ?? null;
}
