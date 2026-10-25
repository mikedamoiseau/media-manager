/**
 * Where a key on one of the Remote's bars (position, volume) goes from `v`: back a step (left, down),
 * forward a step (right, up), or Home to the start. Not End: it would end the film, or turn the volume
 * to full. Null: not a key of the bar (space still plays and pauses).
 */
export function sliderKey(key: string, v: number, o: { max: number; back: number; forward: number }): number | null {
  const to =
    key === 'ArrowLeft' || key === 'ArrowDown' ? v - o.back
    : key === 'ArrowRight' || key === 'ArrowUp' ? v + o.forward
    : key === 'Home' ? 0
    : null;
  return to === null ? null : Math.max(0, Math.min(o.max, to));
}
