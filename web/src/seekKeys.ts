export type SeekKey = { action: 'rewind' | 'forward' } | { action: 'seek'; value: number };

/**
 * What a key does on the Remote's seek bar: skip like the buttons below it, or go back to the start.
 * Not End: seeking to 100% ends the film. Null: the key is the Remote's (space plays and pauses).
 */
export function seekKey(key: string): SeekKey | null {
  if (key === 'ArrowLeft' || key === 'ArrowDown') return { action: 'rewind' };
  if (key === 'ArrowRight' || key === 'ArrowUp') return { action: 'forward' };
  if (key === 'Home') return { action: 'seek', value: 0 };
  return null;
}
