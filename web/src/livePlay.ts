import { api } from './api.ts';
import { toast, tvChoice } from './store.ts';
import type { LiveChannel } from './types.ts';

/** Kodi took up to 11 s to start a channel on the Pi (measured): asking sooner says "not playing" for one that's opening. */
const PLAY_CHECK_MS = 13_000;
/** A channel Kodi still opens is asked about again, this long after, this many times. */
const PLAY_RECHECK_MS = 10_000;
const PLAY_RECHECKS = 2;

let plays = 0;

/**
 * Starts one of the owner's channels on this device's TV (from the guide, or zapping on the Remote); false when
 * the TV refused, which the message says. Kodi keeps a player while a stream fails: the TV is asked whether it
 * really plays (again while it still opens it), unless another channel was started since.
 */
export async function playChannel(ch: Pick<LiveChannel, 'key' | 'name'>, tvName: string | undefined): Promise<boolean> {
  const n = ++plays;
  const onTv = tvChoice.get();
  try {
    await api.post(`/api/livetv/${encodeURIComponent(ch.key)}/play`);
  } catch (e) {
    toast((e as Error).message, 'error');
    return false;
  }
  toast(`Starting ${ch.name} on ${tvName ?? 'the TV'}`);
  const check = (delay: number, left: number) =>
    setTimeout(() => {
      if (n !== plays || onTv !== tvChoice.get()) return;
      api.get<{ state: 'playing' | 'opening' | 'stopped' }>(`/api/livetv/${encodeURIComponent(ch.key)}/playing`).then(
        (r) => {
          if (n !== plays || onTv !== tvChoice.get() || r.state === 'playing') return;
          if (r.state === 'opening' && left > 0) check(PLAY_RECHECK_MS, left - 1);
          else toast(`${ch.name} didn't start: its stream may be down`, 'error');
        },
        () => {},
      );
    }, delay);
  check(PLAY_CHECK_MS, PLAY_RECHECKS);
  return true;
}
