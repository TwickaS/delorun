/**
 * Delorun's brand: the tokens, the hex mark and the component set. The components compose upstream's studio
 * primitives for keyboard, focus and accessibility behaviour and add Delorun's look and API. The package exports its
 * source: a Delorun studio plugin's browser bundle inlines it, and the website and the docs import it through Vite.
 * It needs no Cordis host. Importing this module loads `tokens.css`; load `fonts.css` as well where the page does not
 * already provide Schibsted Grotesk and JetBrains Mono.
 * @module @delorun/brand
 */
import './tokens.css'

export { BRAND_COLOURS, BRAND_FONTS, BRAND_MOTION, BRAND_RADII, BRAND_SPACE } from './tokens.ts'
export { MARK, Mark } from './mark.tsx'
export { Alert, ALERT_CLASSES, ALERT_EXIT_MS, type AlertAction, type AlertKind, type AlertProps, type AlertVariant } from './alert.tsx'
export { Button, type ButtonProps, type ButtonVariant } from './components/Button.tsx'
export { Card, type CardProps } from './components/Card.tsx'
export { CodeBlock, COPY_ANSWER_MS, copyText, type CodeBlockProps } from './components/CodeBlock.tsx'
export { CARD_ICON_TINTS, CardIcon, cardIconLetter, cardIconTint, type CardIconProps, type CardIconTint } from './components/CardIcon.tsx'
export { ConfirmAction, type ConfirmActionProps } from './components/ConfirmAction.tsx'
export { Dialog, type DialogProps } from './components/Dialog.tsx'
export { Frame, type FrameProps } from './components/Frame.tsx'
export { CodeCells, type CodeCellsProps } from './components/CodeCells.tsx'
export { Keypad, type KeypadProps } from './components/Keypad.tsx'
export { Link } from './components/Link.tsx'
export { Notice, type NoticeIcon, type NoticeProps, type NoticeTone } from './components/Notice.tsx'
export { OutcomePanel, type OutcomePanelProps } from './components/OutcomePanel.tsx'
export { PinDots, type PinDotsProps } from './components/PinDots.tsx'
export { Pill, type PillProps } from './components/Pill.tsx'
export { SectionHeading, type SectionHeadingProps } from './components/SectionHeading.tsx'
export { StatusCard, type StatusCardProps } from './components/StatusCard.tsx'
export { TabList, TabPanel, type Tab, type TabListProps, type TabPanelProps } from './components/TabList.tsx'
export { TextField, type TextFieldProps } from './components/TextField.tsx'
export { SecretPair, type SecretPairProps } from './components/SecretPair.tsx'
export { ChoiceGroup, type Choice, type ChoiceGroupProps } from './settings/ChoiceGroup.tsx'
export { cardCss, SettingHeading, SettingsCard, type SettingsCardProps } from './settings/SettingsCard.tsx'
export { RadioList, type RadioListProps, type RadioRow } from './settings/RadioList.tsx'
export { SettingRow, type SettingRowProps } from './settings/SettingRow.tsx'
export { TileGroup, type Tile, type TileGroupProps } from './settings/TileGroup.tsx'
export { ChipGroup, type ChipGroupProps, type ChipOption } from './settings/ChipGroup.tsx'
export { LookChooser, type CustomPanelProps, type LookChooserProps, type LookSampleCopy, type LookTile } from './settings/LookChooser.tsx'
export {
  AccentPicker, StudioLookSwitch, ThemePicker,
  type AccentChoice, type AccentPickerProps, type StudioLook, type StudioLookSwitchProps, type SwatchColours, type ThemeChoice, type ThemePickerProps,
} from './settings/AppearancePickers.tsx'
