/**
 * The workspace icon components the sidebar plugin shares as `ctx.delorunSidebar`. A client bundle may not import
 * another plugin's values, so the Branding section and the brand icon draw and pick a workspace icon through them, and
 * draw the Delorun mark while the sidebar is not mounted.
 * @module @delorun/plugin-theme/client/sidebar-bridge
 */
import type { ComponentType } from 'react'

/** A workspace icon as the sidebar's components take it; this plugin neither reads nor changes its fields. */
export type SharedIcon = object

/** The part of `ctx.delorunSidebar` this plugin uses. */
export interface SidebarComponents {
  readonly IconBadge: ComponentType<{ readonly icon: SharedIcon | undefined; readonly title: string; readonly size: number }>
  readonly IconPickerDialog: ComponentType<{
    readonly title: string
    readonly icon: SharedIcon | undefined
    readonly onSave: (icon: SharedIcon | null) => void
    readonly onClose: () => void
  }>
}

/** What a caller uses: the components, and the parse of a stored picked icon. */
export interface SidebarBridge {
  readonly service: SidebarComponents
  /**
   * Read a stored picked icon.
   * @param text - the stored JSON.
   * @returns the icon, or undefined when it is no JSON object.
   */
  parse(text: string): SharedIcon | undefined
}

let source: (() => unknown) | undefined

/**
 * Look up the sidebar service on a context at each use.
 * @param ctx - the plugin's context.
 */
export function watchSidebar(ctx: object): void {
  source = () => Reflect.get(ctx, 'delorunSidebar')
}

/**
 * @returns the sidebar's shared components, or undefined while the sidebar is not mounted.
 */
export function sidebarBridge(): SidebarBridge | undefined {
  const service = source?.()
  if (typeof service !== 'object' || service === null || !('IconBadge' in service) || !('IconPickerDialog' in service)) return undefined
  return {
    service: service as SidebarComponents,
    parse: (text) => {
      try {
        const value: unknown = JSON.parse(text)
        return typeof value === 'object' && value !== null ? value : undefined
      } catch {
        // A stored picked icon that is not JSON is drawn as the Delorun mark.
        return undefined
      }
    },
  }
}
