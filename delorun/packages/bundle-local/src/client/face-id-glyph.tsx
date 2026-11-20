/**
 * The Face ID glyph inside the sheet's Confirm button: four corner brackets, two eyes, a nose and a smile, drawn in
 * the button's text colour. Other platform unlocks use the shield, since they have no face to draw.
 */
import type { ReactNode } from 'react'
import { IconShieldOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FaceIdKind } from './face-id-types.ts'

/**
 * Render the glyph for a platform unlock.
 * @param props.kind - the platform's unlock.
 * @param props.size - the glyph's side in pixels.
 * @returns the glyph, hidden from assistive technology.
 */
export function FaceIdGlyph({ kind, size = 22 }: { readonly kind: FaceIdKind; readonly size?: number }): ReactNode {
  if (kind !== 'faceId') return <IconShieldOutlineMedium size={size} />
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8V6.5A3.5 3.5 0 0 1 6.5 3H8M16 3h1.5A3.5 3.5 0 0 1 21 6.5V8M21 16v1.5a3.5 3.5 0 0 1-3.5 3.5H16M8 21H6.5A3.5 3.5 0 0 1 3 17.5V16" />
    <path d="M9 9.5v1.2M15 9.5v1.2M12 9.5v3.3h-.8M8.8 15.5c.8.9 1.8 1.4 3.2 1.4s2.4-.5 3.2-1.4" />
  </svg>
}
