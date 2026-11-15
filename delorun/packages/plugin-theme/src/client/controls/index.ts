/**
 * The appearance controls Settings → Appearance and onboarding's Look step share. This entry imports nothing from the
 * studio, so a browser bundle can inline it.
 * @module @delorun/plugin-theme/client/controls
 */
export { ChipGroup, type ChipGroupProps, type ChipOption } from './ChipGroup.tsx'
export {
  AccentPicker, StudioLookSwitch, ThemePicker,
  type AccentChoice, type AccentPickerProps, type StudioLook, type StudioLookSwitchProps, type SwatchColours, type ThemeChoice, type ThemePickerProps,
} from './pickers.tsx'
