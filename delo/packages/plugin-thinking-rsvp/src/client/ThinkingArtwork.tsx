/** The Thinking tab's artwork on the right Sidebar's start page: the package's `icon.svg`, drawn per instance. */

import { useId, type ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Draw the package icon, a band between two lines of a page, for a guide entry.
 * @param props - canvas size and layout class supplied by the guide.
 * @returns an ornamental SVG hidden from assistive technology.
 */
export function ThinkingArtwork({ size = 36, className }: IconProps): ReactNode {
  // Each drawing names its own gradient, since the page may hold several.
  const band = useId()
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="7" width="18" height="3.4" rx="1.7" fill="#9AA6BC" fillOpacity="0.7" />
      <rect x="5.5" y="13.5" width="25" height="9" rx="4.5" fill={`url(#${band})`} fillOpacity="0.85" />
      <rect x="17" y="15.5" width="2" height="5" rx="1" fill="#FFFFFF" />
      <rect x="9" y="25.6" width="13" height="3.4" rx="1.7" fill="#9AA6BC" fillOpacity="0.7" />
      <defs>
        <linearGradient id={band} x1="5.5" y1="18" x2="30.5" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7AC2FF" />
          <stop offset="1" stopColor="#4A65E8" />
        </linearGradient>
      </defs>
    </svg>
  )
}
