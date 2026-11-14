/**
 * The settings controls every Delorun Settings section shares: the card with its sentence-case heading, a setting's
 * title and help, the frame of a General row, the radio segmented control and the preview tiles. The controls live in
 * `@delorun/brand`, which is their one source; this module re-exports them so a section's imports keep working.
 * @module @delorun/settings-controls
 */
export {
  cardCss,
  ChoiceGroup,
  SettingHeading,
  SettingRow,
  SettingsCard,
  TileGroup,
  type Choice,
  type ChoiceGroupProps,
  type SettingRowProps,
  type SettingsCardProps,
  type Tile,
  type TileGroupProps,
} from '@delorun/brand'
