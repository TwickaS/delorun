/**
 * The preview chip's copy. A plugin spreads it into its own dictionaries and passes its bound translate function to
 * `PreviewChip`, so the words have one source.
 * @module @delorun/preview-flags/locales
 */

/** English dictionary. */
export const en = {
  'previewFlag.chip': 'Preview',
  'previewFlag.tooltip': 'A preview of what is planned. It is not built yet, so choosing it changes nothing.',
} as const

/** Key union derived from the English dictionary. */
export type PreviewFlagLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh: Record<PreviewFlagLocaleKey, string> = {
  'previewFlag.chip': '预览',
  'previewFlag.tooltip': '这是计划中功能的预览，尚未实现，选择它不会改变任何设置。',
}
