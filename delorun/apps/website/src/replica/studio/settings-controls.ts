/**
 * The one settings control the real Setup versions section uses, from its own file. The replica's build answers the
 * section's `@delorun/settings-controls` import with this module, so the replica never reaches the brand's index and the
 * look chooser it re-exports.
 * @module @delorun/website/replica/studio/settings-controls
 */
export { SettingsCard } from '@brand/settings/SettingsCard.tsx'
