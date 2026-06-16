/**
 * OrientationHint — a CSS-only-revealed "rotate to landscape" steer for narrow,
 * touch, portrait viewports. This component owns ONLY the markup + the dismiss
 * STATE; the stylesheet (styles.css) owns ALL visuals keyed off the shared
 * class names (`rotate-hint`, `rotate-hint__close`, `rotate-hint--dismissed`).
 *
 * It is ALWAYS rendered (App mounts it unconditionally as a sibling of
 * .stage-viewport). There is NO matchMedia / JS media logic here — visibility is
 * entirely CSS-driven: the base `.rotate-hint` rule is display:none, and only the
 * portrait + coarse-pointer + narrow media query reveals it. A 1080p desktop
 * (fine pointer, landscape, wide) never matches, so it renders but never paints —
 * the console stays pixel-identical.
 *
 * The overlay is aria-hidden: it is a decorative steer, not essential content
 * (the console remains reachable, and a portrait user can dismiss + pinch-zoom).
 * Tapping the close button adds `rotate-hint--dismissed`; the stylesheet's
 * `.rotate-hint--dismissed { display:none !important; }` (placed AFTER the @media
 * reveal so it wins) then hides it even while the portrait media query matches.
 *
 * NO inline styles that position/size/color the overlay — those belong to
 * styles.css. The component supplies only structure, the aria attribute, and the
 * dismiss class toggle.
 */

import { useState } from 'react';

export function OrientationHint() {
  const [dismissed, setDismissed] = useState(false);

  return (
    <div
      className={dismissed ? 'rotate-hint rotate-hint--dismissed' : 'rotate-hint'}
      aria-hidden={true}
    >
      <button
        type="button"
        className="rotate-hint__close"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
      >
        {'✕'}
      </button>
      {/* Rotate glyph — inline SVG, no external asset: a phone outline with a
       * curved rotate arrow, hinting "turn the device sideways". */}
      <svg
        className="rotate-hint__glyph"
        viewBox="0 0 64 64"
        width="64"
        height="64"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="20" y="8" width="24" height="40" rx="4" />
        <line x1="28" y1="42" x2="36" y2="42" />
        <path d="M14 52 a18 18 0 0 0 32 6" />
        <polyline points="46 50 46 60 36 58" />
      </svg>
      <p className="rotate-hint__title">Rotate your device to landscape</p>
      <p className="rotate-hint__subtitle">
        This console is designed for a wider screen.
      </p>
    </div>
  );
}
