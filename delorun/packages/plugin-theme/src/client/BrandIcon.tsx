/**
 * The icon that stands for the studio: the Delorun mark, the workspace icon the person picked, or the image they
 * uploaded. Nothing is drawn while the mark is hidden.
 */
import { STUDIO_ICON_PATH } from '@delorun/brand/branding'
import { parseWorkspaceIcon, type WorkspaceIcon } from '@delorun/brand/workspace-icon'
import { WorkspaceBadge } from '@delorun/brand/workspace-badge'
import { MARK } from '@delorun/brand/mark'
import type { BrandingView } from './branding-store.ts'
import css from './brand-icon.module.css'

/**
 * Read a stored picked icon.
 * @param text - the stored JSON.
 * @returns the icon, or undefined when it is not JSON or not a workspace icon.
 */
export function readPicked(text: string): WorkspaceIcon | undefined {
  try {
    return parseWorkspaceIcon(JSON.parse(text))
  } catch {
    // A stored picked icon that is not JSON is drawn as the Delorun mark.
    return undefined
  }
}

/**
 * Render the branding's icon at one size.
 * @param props.branding - the published branding.
 * @param props.size - the square edge in pixels.
 * @returns the icon, or nothing while the mark is hidden.
 */
export function BrandIcon({ branding, size }: { readonly branding: BrandingView; readonly size: number }) {
  if (!branding.showMark) return null
  if (branding.icon === 'upload') {
    return <img className={css.image} src={`${STUDIO_ICON_PATH}?v=${String(branding.revision)}`} width={size} height={size} alt="" data-delorun-brand-icon="upload" />
  }
  const picked = branding.icon === 'picked' ? readPicked(branding.pickedIcon) : undefined
  if (picked !== undefined) return <span data-delorun-brand-icon="picked"><WorkspaceBadge title={branding.name} color="blue" icon={picked} size={size} /></span>
  return (
    <svg className={css.mark} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" data-delorun-brand-icon="mark">
      <path d={MARK.nut} fill="currentColor" fillRule="evenodd" />
      <circle cx={MARK.plug.cx} cy={MARK.plug.cy} r={MARK.plug.r} fill="var(--accent, currentColor)" />
    </svg>
  )
}
