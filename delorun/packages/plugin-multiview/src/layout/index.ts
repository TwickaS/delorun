/**
 * The Multiview layout: the model, its operations, the presets, Auto, the person's own shape, the limits, the picker and the
 * adapter that draws them. Everything the other Multiview lanes use of the layout comes through this module.
 * @module @delorun/plugin-multiview/layout
 */

export * from './limits.ts'
export * from './model.ts'
export * from './ops.ts'
export * from './presets.ts'
export * from './arrange.ts'
export * from './choices.ts'
export * from './fit.ts'
export * from './focus.ts'
export * from './shape.ts'
export * from './share.ts'
export { en as layoutsEn, LAYOUTS_NS, zh as layoutsZh, type LayoutsLocaleKey } from './locales.ts'
export type * from './props.ts'
export * from './actions.ts'
export { PaneLayout } from './PaneLayout.tsx'
export { LayoutThumb, thumbModel, type LayoutThumbProps } from './LayoutThumb.tsx'
export { LayoutPicker, type LayoutPickerProps } from './LayoutPicker.tsx'
