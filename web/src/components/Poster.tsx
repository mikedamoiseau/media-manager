import { useState } from 'react';

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Poster image with a typographic fallback (like a hand-labelled tape) when there is no artwork. */
export function Poster({ src, title, year, className = '' }: { src: string | null; title: string; year?: number | null; className?: string }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>(src ? 'loading' : 'error');
  const showFallback = !src || state === 'error';
  return (
    <div className={`poster ${className}`} style={{ '--h': hue(title) } as React.CSSProperties}>
      {showFallback && (
        <div className="poster-fallback" aria-hidden="true">
          <span className="poster-fallback-title">{title}</span>
          {year ? <span className="poster-fallback-year">{year}</span> : null}
        </div>
      )}
      {src && state !== 'error' && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          data-loaded={state === 'ok'}
          onLoad={() => setState('ok')}
          onError={() => setState('error')}
        />
      )}
    </div>
  );
}
