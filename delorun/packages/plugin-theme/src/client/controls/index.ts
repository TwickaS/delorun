/**
 * The appearance controls Settings → Appearance and onboarding's Look step share. They live in `@delorun/brand`, which
 * is their one source; this entry re-exports them so an importer of `@delorun/plugin-theme/controls` keeps working.
 * @module @delorun/plugin-theme/client/controls
 */
export {
  AccentPicker, ChipGroup, StudioLookSwitch, ThemePicker,
  type AccentChoice, type AccentPickerProps, type ChipGroupProps, type ChipOption, type StudioLook, type StudioLookSwitchProps, type SwatchColours, type ThemeChoice, type ThemePickerProps,
} from '@delorun/brand'
