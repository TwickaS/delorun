/** The padlock that marks PIN mode in Settings navigation; the icon library has no lock. */
import type { ReactNode } from 'react'

/**
 * Draw a padlock at the size and class Settings gives its navigation glyphs.
 * @param props - the glyph's size in pixels and class name.
 * @returns the SVG.
 */
export function PinModeIcon({ size = 20, className }: { size?: number; className?: string | undefined }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <rect x="4" y="9" width="12" height="8" rx="2" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    <circle cx="10" cy="13" r="1" fill="currentColor" stroke="none" />
  </svg>
}
