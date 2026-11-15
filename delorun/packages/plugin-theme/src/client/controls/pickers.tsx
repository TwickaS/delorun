/**
 * The three appearance pickers built on {@link ChipGroup}: the theme with its light and dark swatch, the accent with
 * its dot, and the studio look. Settings → Appearance and onboarding's Look step both render these, with their own text.
 * @module @delorun/plugin-theme/client/controls/pickers
 */
import type { CSSProperties } from 'react'
import { ChipGroup } from './ChipGroup.tsx'
import css from './controls.module.css'

/** One scheme of a theme swatch: the page, primary text and the accent, as CSS colours. */
export interface SwatchColours {
  readonly page: string
  readonly text: string
  readonly accent: string
}

/** One theme chip. */
export interface ThemeChoice<Value extends string> {
  readonly value: Value
  readonly label: string
  readonly light: SwatchColours
  readonly dark: SwatchColours
}

/** The props of {@link ThemePicker}. */
export interface ThemePickerProps<Value extends string> {
  readonly label: string
  readonly value: Value
  readonly themes: readonly ThemeChoice<Value>[]
  readonly onChange: (next: Value) => void
  readonly disabled?: boolean
  /** Whether the label only names the group for assistive technology, because a heading beside it already shows it. */
  readonly hideLabel?: boolean
}

/** A theme's two schemes side by side, each with a line in its text colour and a dot in its accent. */
function ThemeSwatch({ light, dark }: { readonly light: SwatchColours; readonly dark: SwatchColours }) {
  const half = (colours: SwatchColours): CSSProperties => (
    { '--half-page': colours.page, '--half-text': colours.text, '--half-accent': colours.accent } as CSSProperties
  )
  return (
    <span className={css.swatch}>
      <span className={css.half} style={half(light)}><span className={css.line} /><span className={css.halfDot} /></span>
      <span className={css.half} style={half(dark)}><span className={css.line} /><span className={css.halfDot} /></span>
    </span>
  )
}

/**
 * The theme chips.
 * @param props - see {@link ThemePickerProps}.
 * @returns the group.
 */
export function ThemePicker<Value extends string>({ label, value, themes, onChange, disabled, hideLabel }: ThemePickerProps<Value>) {
  return (
    <ChipGroup label={label} value={value} onChange={onChange} disabled={disabled === true} hideLabel={hideLabel === true}
      options={themes.map(theme => ({ value: theme.value, label: theme.label, mark: <ThemeSwatch light={theme.light} dark={theme.dark} /> }))} />
  )
}

/** One accent chip: its fill in each scheme. */
export interface AccentChoice<Value extends string> {
  readonly value: Value
  readonly label: string
  /** The dot's CSS background in the light scheme. */
  readonly light: string
  /** The dot's CSS background in the dark scheme. */
  readonly dark: string
}

/** The props of {@link AccentPicker}. */
export interface AccentPickerProps<Value extends string> {
  readonly label: string
  readonly value: Value
  readonly accents: readonly AccentChoice<Value>[]
  readonly onChange: (next: Value) => void
  /** Whether the accents cannot be chosen, as while a theme brings its own. */
  readonly disabled?: boolean
  /** Whether the label only names the group for assistive technology. */
  readonly hideLabel?: boolean
}

/**
 * The accent chips.
 * @param props - see {@link AccentPickerProps}.
 * @returns the group.
 */
export function AccentPicker<Value extends string>({ label, value, accents, onChange, disabled, hideLabel }: AccentPickerProps<Value>) {
  return (
    <ChipGroup label={label} value={value} onChange={onChange} disabled={disabled === true} hideLabel={hideLabel === true}
      options={accents.map(accent => ({
        value: accent.value,
        label: accent.label,
        mark: <span className={css.accentDot} style={{ '--accent-light': accent.light, '--accent-dark': accent.dark } as CSSProperties} />,
      }))} />
  )
}

/** The studio looks. */
export type StudioLook = 'delorun' | 'stock'

/** The props of {@link StudioLookSwitch}. */
export interface StudioLookSwitchProps {
  readonly label: string
  /** The chosen look; Settings and onboarding only ever show Delorun chosen, since the stock look unloads them. */
  readonly value: StudioLook
  readonly delorunLabel: string
  readonly stockLabel: string
  readonly onChange: (next: StudioLook) => void
  readonly disabled?: boolean
}

/**
 * The Delorun or Stock chips. The arrow keys only move focus: choosing Stock unloads the Delorun studio plugins.
 * @param props - see {@link StudioLookSwitchProps}.
 * @returns the group.
 */
export function StudioLookSwitch({ label, value, delorunLabel, stockLabel, onChange, disabled }: StudioLookSwitchProps) {
  return (
    <ChipGroup<StudioLook> label={label} value={value} onChange={onChange} disabled={disabled === true} manual
      options={[{ value: 'delorun', label: delorunLabel }, { value: 'stock', label: stockLabel }]} />
  )
}
