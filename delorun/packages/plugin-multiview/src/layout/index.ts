/**
 * The Multiview layout: the model, its operations, the presets and the limits, and the adapter that draws them. Everything the
 * other Multiview lanes use of the layout comes through this module.
 * @module @delorun/plugin-multiview/layout
 */

export * from './limits.ts'
export * from './model.ts'
export * from './ops.ts'
export * from './presets.ts'
export type * from './props.ts'
export * from './actions.ts'
export { PaneLayout } from './PaneLayout.tsx'
