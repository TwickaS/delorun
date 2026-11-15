/** The sidebar header's brand occupants under the person's own branding: the icon and the name, or nothing while the mark is hidden. */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BrandIcon } from './BrandIcon.tsx'
import { useBranding } from './branding-store.ts'

/**
 * The sidebar's brand mark.
 * @param props - the square edge the sidebar asks for.
 * @returns the icon, or nothing while the mark is hidden.
 */
export function SidebarBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <BrandIcon branding={useBranding()} size={size} />
}

/** @returns the brand name, or nothing while the mark is hidden. */
export function SidebarBrandName() {
  const { showMark, name } = useBranding()
  return showMark ? <span>{name}</span> : null
}
