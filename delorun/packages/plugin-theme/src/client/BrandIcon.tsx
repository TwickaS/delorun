/**
 * The icon that stands for the studio: the Delorun mark, the workspace icon the person picked, or the image they
 * uploaded. Nothing is drawn while the mark is hidden.
 */
import { STUDIO_ICON_PATH } from '@delorun/brand/branding'
import { MARK } from '@delorun/brand/mark'
import { sidebarBridge } from './sidebar-bridge.ts'
import type { BrandingView } from './branding-store.ts'
import css from './brand-icon.module.css'

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
  const bridge = branding.icon === 'picked' ? sidebarBridge() : undefined
  const picked = bridge?.parse(branding.pickedIcon)
  if (bridge !== undefined && picked !== undefined) {
    const Badge = bridge.service.IconBadge
    return <span data-delorun-brand-icon="picked"><Badge title={branding.name} icon={picked} size={size} /></span>
  }
  return (
    <svg className={css.mark} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" data-delorun-brand-icon="mark">
      <path d={MARK.nut} fill="currentColor" fillRule="evenodd" />
      <circle cx={MARK.plug.cx} cy={MARK.plug.cy} r={MARK.plug.r} fill="var(--accent, currentColor)" />
    </svg>
  )
}
