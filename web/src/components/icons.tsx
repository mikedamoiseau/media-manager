import type { SVGProps } from 'react';
import { isTablet } from '../vlc.ts';

type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 22, ...rest }: P) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  };
}

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const IconBack = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
export const IconPlay = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8Z" />
  </svg>
);
export const IconPause = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="6" y="4.5" width="4" height="15" rx="1" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" />
  </svg>
);
export const IconStop = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
);
export const IconFilm = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4" width="17" height="16" rx="2" />
    <path d="M7.5 4v16M16.5 4v16M3.5 8.5h4M3.5 15.5h4M16.5 8.5h4M16.5 15.5h4" />
  </svg>
);
export const IconInbox = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 13.5 6.5 5h11L20 13.5V19H4Z" />
    <path d="M4 13.5h4.5l1.2 2.2h4.6l1.2-2.2H20" />
  </svg>
);
export const IconRemote = (p: P) => (
  <svg {...base(p)}>
    <rect x="7" y="2.5" width="10" height="19" rx="3" />
    <circle cx="12" cy="9" r="2.4" />
    <path d="M10 15h.01M14 15h.01M10 18h.01M14 18h.01" />
  </svg>
);
export const IconSettings = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </svg>
);
export const IconSets = (p: P) => (
  <svg {...base(p)}>
    <rect x="8" y="3" width="12" height="15" rx="2" />
    <path d="M4.5 7.5V19a2 2 0 0 0 2 2H15" />
  </svg>
);

export const IconFilter = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
const thumb = 'M7 10v11H4.5A1.5 1.5 0 0 1 3 19.5v-8A1.5 1.5 0 0 1 4.5 10H7l4-8a2.8 2.8 0 0 1 3 3v4h5.3a2 2 0 0 1 2 2.3l-1.3 8.5A2 2 0 0 1 18 21H7';
export const IconThumbUp = (p: P) => (
  <svg {...base(p)}>
    <path d={thumb} />
  </svg>
);
export const IconThumbDown = (p: P) => (
  <svg {...base(p)}>
    <path d={thumb} transform="rotate(180 12 12)" />
  </svg>
);
export const IconTv = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="12" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);
export const IconYoutube = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
    <path d="m10 9.2 5 2.8-5 2.8Z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconImage = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <circle cx="9" cy="9" r="1.8" />
    <path d="m20.5 15-5-5-9 10.5" />
  </svg>
);
export const IconLink = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);
export const IconEye = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);
export const IconEyeOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 4l16 16M10.6 6A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-3 3.6M6.4 7.6A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9" />
    <path d="M9.9 9.9a2.8 2.8 0 0 0 4.2 4.2" />
  </svg>
);
/** This device: a tablet on the iPad, a phone otherwise. */
export const IconDevice = (p: P) => (
  <svg {...base(p)}>
    {isTablet ? <rect x="4" y="2.5" width="16" height="19" rx="2" /> : <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />}
    <path d="M10.5 18.5h3" />
  </svg>
);

export const IconPower = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v8" />
    <path d="M6.3 6.8a8 8 0 1 0 11.4 0" />
  </svg>
);

export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 11a8 8 0 0 0-14.6-4.5M4 13a8 8 0 0 0 14.6 4.5" />
    <path d="M5 3v4h4M19 21v-4h-4" />
  </svg>
);
export const IconUp = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 15 6-6 6 6" />
  </svg>
);
export const IconDown = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const IconLeft = (p: P) => (
  <svg {...base(p)}>
    <path d="m15 6-6 6 6 6" />
  </svg>
);
export const IconRight = (p: P) => (
  <svg {...base(p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
export const IconHome = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 11 12 4l8 7v9h-5.5v-5.5h-5V20H4Z" />
  </svg>
);
export const IconInfo = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </svg>
);
export const IconMenu = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 6h.01M12 12h.01M12 18h.01" strokeWidth="3" />
  </svg>
);
export const IconSkipBack = (p: P) => (
  <svg {...base(p)}>
    <path d="M11 7.5 5.5 12l5.5 4.5Z M18.5 7.5 13 12l5.5 4.5Z" fill="currentColor" />
  </svg>
);
export const IconSkipFwd = (p: P) => (
  <svg {...base(p)}>
    <path d="M13 7.5 18.5 12 13 16.5Z M5.5 7.5 11 12l-5.5 4.5Z" fill="currentColor" />
  </svg>
);
export const IconVolume = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4Z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);
export const IconMinus = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
);
export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconMute = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4Z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </svg>
);
export const IconSubtitles = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 12.5h3M12.5 12.5H17M7 15.5h6M15 15.5h2" />
  </svg>
);
export const IconAudio = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
  </svg>
);
export const IconKeyboard = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" />
  </svg>
);
export const IconUpload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
);
