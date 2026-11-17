/**
 * The studio half of the preview flags, a library a plugin's browser bundle imports: the page's store, the provider and
 * `usePreviewFlag`, and the shared `PreviewChip`. It imports no Cordis.
 * @module @delorun/preview-flags/client
 */
export { previewFlagId } from '../flags.ts'
export type { PreviewFlagId } from '../flags.ts'
export { PREVIEW_FLAG_ROUTES, type PreviewFlagsAnswer, type PreviewFlagView } from '../wire.ts'
export { PreviewFlagsProvider, usePreviewFlag } from './hooks.tsx'
export { en, zh, type PreviewFlagLocaleKey } from './locales.ts'
export { PreviewChip, type PreviewChipProps } from './PreviewChip.tsx'
export { createPreviewFlagsStore, flagOn, type PreviewFlagsFetch, type PreviewFlagsSnapshot, type PreviewFlagsStore } from './store.ts'
