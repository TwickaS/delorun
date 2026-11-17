/**
 * `createPortal` for the upstream primitives inside the replica: it renders the dialog where the section renders it,
 * inside the drawn studio, instead of in the page's `body`. The studio's root contains its layout and paint, so a
 * dialog's fixed overlay covers the drawn studio and nothing else, and it stays inside the scoped tokens. The replica's
 * build answers the primitives' `react-dom` import with this module.
 * @module @delorun/website/replica/studio/inline-portal
 */
import type { ReactNode } from 'react'

/**
 * Render a portal's children in place.
 * @param children - what the portal would render.
 * @returns the children.
 */
export function createPortal(children: ReactNode): ReactNode {
  return children
}
