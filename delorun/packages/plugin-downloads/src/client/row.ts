/**
 * The setup guide's row on its own, so the onboarding plugin's bundle carries the row and not the whole panel.
 * @module @delorun/plugin-downloads/row
 */
export { OnboardingDownloadsRow, type OnboardingDownloadsRowProps } from './Phone.tsx'
export { createFakeDownloadsSource, currentDownloadsSource, provideDownloadsSource } from './source.ts'
export { useDownloadRateText } from './rate.ts'
