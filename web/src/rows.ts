// The library's rows above the grid, each with a page of its own (/row/<key>) showing all its titles.

export type RowKey = 'continue' | 'suggested' | 'elsewhere' | 'cinema';

export const ROW_TITLES: Record<RowKey, string> = {
  continue: 'Continue watching',
  suggested: 'Suggested for you',
  elsewhere: 'Not on the NAS',
  cinema: 'At the cinema',
};

// Kids mode: only the rows of the kid's own titles.
const KIDS_ROWS = new Set<RowKey>(['continue', 'suggested']);

/** The row whose page this path is; none for any other path, or a row a kid doesn't get. */
export function rowOf(path: string, kids: boolean): RowKey | null {
  const key = /^\/row\/([a-z]+)$/.exec(path)?.[1];
  if (!key || !Object.hasOwn(ROW_TITLES, key)) return null;
  return kids && !KIDS_ROWS.has(key as RowKey) ? null : (key as RowKey);
}
