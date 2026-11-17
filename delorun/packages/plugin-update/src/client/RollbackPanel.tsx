/**
 * The Go back panel of Settings → Updates. The `recui` lane owns this file and replaces this placeholder; the props are
 * the seam `UpdatePanel` renders it through.
 */
import type { RollbackBody, UpdateStateView } from '../wire.ts'
import type { Outcome, UpdateRefusal } from './controller.ts'
import type { T } from './parts.tsx'

/** Props of {@link RollbackPanel}. */
export interface RollbackPanelProps {
  readonly state: UpdateStateView
  readonly t: T
  /** Go back from the committed update. */
  readonly rollback: (body: RollbackBody) => Promise<Outcome<unknown>>
}

/** Re-exported so the panel can word a refusal the same way as the dialog. */
export type { UpdateRefusal }

/**
 * Render the panel.
 * @param _props - the state, the dictionary and the rollback action.
 * @returns nothing until `recui` builds the panel.
 */
export function RollbackPanel(_props: RollbackPanelProps) {
  return null
}
