/**
 * The product icons the replica's primitives draw, defined as upstream's `icons/index.tsx` defines them (an `<svg>` that
 * uses a sprite symbol), with a sprite of just those icons made at build time from upstream's artwork. The replica's
 * build answers the primitives' `./icons/index.tsx` import with this module; a primitive that draws another icon fails
 * the build on a missing export, and its glyph is added to `icon-list.ts`.
 * @module @delorun/website/replica/studio/icons
 */
import type { ReactNode } from 'react'
import { SIZES, SYMBOLS } from 'virtual:replica-icons'
import type { REPLICA_ICONS } from './icon-list.ts'

/** Props of a product icon, as upstream's. */
interface IconProps {
  readonly size?: number | undefined
  readonly className?: string | undefined
}

/**
 * An icon that draws one sprite symbol.
 * @param glyph - the glyph.
 * @returns the icon component.
 */
function productIcon(glyph: typeof REPLICA_ICONS[number]): (props: IconProps) => ReactNode {
  const id = `dsw-icon-${glyph}-regular`
  return ({ size = SIZES[glyph], className }: IconProps) => <svg width={size} height={size} className={className} data-icon={id} aria-hidden="true"><use href={`#${id}`} /></svg>
}

/** Regular one-pixel close artwork. */
export const IconCloseOutlineRegular = productIcon('close-outline')
/** Regular one-pixel warning artwork. */
export const IconWarningOutlineRegular = productIcon('warning-outline')
/** Regular one-pixel check artwork. */
export const IconCheckOutlineRegular = productIcon('check-outline')

/**
 * The sprite of the replica's icons, as the studio's theme plugin puts it in the document.
 * @returns the hidden sprite.
 */
export function IconSprite(): ReactNode {
  return <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute' }} dangerouslySetInnerHTML={{ __html: SYMBOLS }} />
}
