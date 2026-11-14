/**
 * The settings controls every Delorun Settings section shares, so the sections
 * render alike: the card with its sentence-case heading, a setting's title
 * and help, the frame of a General row, the radio segmented control and the
 * preview tiles. The package exports its source: a Delorun plugin's browser
 * bundle inlines it, because the page's module table does not provide Delorun's
 * packages.
 * @module @delorun/settings-controls
 */
export { ChoiceGroup, type Choice, type ChoiceGroupProps } from './ChoiceGroup.tsx'
export { cardCss, SettingHeading, SettingsCard, type SettingsCardProps } from './SettingsCard.tsx'
export { SettingRow, type SettingRowProps } from './SettingRow.tsx'
export { TileGroup, type Tile, type TileGroupProps } from './TileGroup.tsx'
