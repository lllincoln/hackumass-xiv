// Small inline icons (no icon font or network). All are decorative: buttons carry their own labels.

import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** A cube seen in wireframe: the x-ray view. */
export const XRayIcon = () => (
  <Svg>
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="M4 7.5 12 12l8-4.5M12 12v9" />
  </Svg>
);

export const CameraIcon = () => (
  <Svg>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.2-2h6.2l1.2 2h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.500 19h-11A2.5 2.5 0 0 1 4 16.500v-8Z" />
    <circle cx="12" cy="12.500" r="3.5" />
  </Svg>
);

export const MicIcon = () => (
  <Svg>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.500 11.500a6.500 6.500 0 0 0 13 0M12 18v3" />
  </Svg>
);

export const SlidersIcon = () => (
  <Svg>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
);

export const ArrowIcon = () => (
  <Svg>
    <path d="M12 20V5M6 11l6-6 6 6" />
  </Svg>
);

export const LogoMark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="3.500" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M32 8 54 20v24L32 56 10 44V20L32 8Z" />
    <path d="M10 20 32 32l22-12M32 32v24" opacity="0.55" />
    <circle cx="32" cy="32" r="5" fill="currentColor" stroke="none" />
  </svg>
);
