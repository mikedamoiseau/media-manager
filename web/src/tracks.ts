import type { AudioStream, SubtitleStream } from './types.ts';

let names: Intl.DisplayNames | null = null;
try {
  names = new Intl.DisplayNames(['en'], { type: 'language' });
} catch {
  names = null;
}

/** Kodi reports ISO 639-2 codes ("fre", "dut", "scr"); show "French", "Dutch", "Croatian". */
export function languageName(code?: string): string {
  if (!code || code === 'und' || code === 'unk') return 'Unknown language';
  try {
    const n = names?.of(code);
    if (n && n !== code && n !== 'root') return n;
  } catch {
    /* not a language code */
  }
  return code.toUpperCase();
}

function channelsLabel(n?: number): string | undefined {
  if (!n) return undefined;
  if (n === 1) return 'mono';
  if (n === 2) return 'stereo';
  return `${n - 1}.1`;
}

/** Second line of an audio track: what tells two French tracks apart (VFF vs VFQ, 5.1 vs stereo). */
export function audioDetail(a: AudioStream): string {
  const parts = [a.name ?? [a.codec?.toUpperCase(), channelsLabel(a.channels)].filter(Boolean).join(' ')];
  if (a.isOriginal) parts.push('original');
  if (a.isImpaired) parts.push('audio description');
  return parts.filter(Boolean).join(', ');
}

export function subtitleDetail(s: SubtitleStream): string {
  return [s.name, s.isForced && 'forced', s.isImpaired && 'for the deaf and hard of hearing'].filter(Boolean).join(', ');
}
