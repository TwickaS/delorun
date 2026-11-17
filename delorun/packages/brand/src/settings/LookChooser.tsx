/**
 * The Look chooser both Settings → Appearance and onboarding's Look step render: the colour scheme as one segmented row,
 * the themes as a grid of small rendered tiles ending in Custom, the custom panel (shown only while Custom is chosen)
 * and a compact live sample that follows the tile under the pointer or focus. It owns no copy and no storage; callers pass
 * their own text and write the choices.
 * @module @delorun/brand/settings/LookChooser
 */
import { useId, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AccentPicker, type AccentChoice, type SwatchColours } from './AppearancePickers.tsx'
import { ChipGroup } from './ChipGroup.tsx'
import css from './LookChooser.module.css'

/** One theme tile: its colours in each scheme. Custom is the last tile. */
export interface LookTile<Value extends string> {
  readonly value: Value
  readonly label: string
  readonly light: SwatchColours
  readonly dark: SwatchColours
}

/** The text of the sample. */
export interface LookSampleCopy {
  /** The sample's accessible name. */
  readonly label: string
  /** The person's message. */
  readonly ask: string
  /** The tool chip. */
  readonly tool: string
  /** The agent's answer. */
  readonly answer: string
  /** The input's placeholder. */
  readonly box: string
}

/** The custom panel's text and values. */
export interface CustomPanelProps<Accent extends string> {
  /** The accent group's name. */
  readonly accentLabel: string
  /** The accent presets and the free colour, in display order. */
  readonly accents: readonly AccentChoice<Accent>[]
  /** The chosen accent. */
  readonly accent: Accent
  /** Called with a chosen accent. */
  readonly onAccent: (next: Accent) => void
  /** The colour picker's name. */
  readonly colourLabel: string
  /** The hex input's name. */
  readonly hexLabel: string
  /** The message under an invalid hex. */
  readonly hexInvalid: string
  /** The saved custom colour as `#RRGGBB`. */
  readonly colour: string
  /** Called with a valid `#RRGGBB` colour. */
  readonly onColour: (next: string) => void
  /** Whether the text is a valid colour. */
  readonly isColour: (text: string) => boolean
  /** More custom values, such as contrast, laid out under the accent. */
  readonly more?: ReactNode
}

/** The props of {@link LookChooser}. */
export interface LookChooserProps<Mode extends string, Theme extends string, Accent extends string> {
  /** The group names. */
  readonly modeLabel: string
  readonly themeLabel: string
  /** The scheme options and the chosen one. */
  readonly modes: readonly { readonly value: Mode; readonly label: string }[]
  readonly mode: Mode
  readonly onMode: (next: Mode) => void
  /** The theme tiles, the last being the custom one, and the chosen theme. */
  readonly themes: readonly LookTile<Theme>[]
  readonly theme: Theme
  readonly onTheme: (next: Theme) => void
  /** The theme value that opens the custom panel. */
  readonly customTheme: Theme
  readonly custom: CustomPanelProps<Accent>
  readonly sample: LookSampleCopy
  /** Whether every control refuses a choice. */
  readonly disabled?: boolean
}

/** A theme tile's picture: a light and a dark half, each a page with a raised surface, a text line and an accent pill. */
function TileSwatch({ light, dark }: { readonly light: SwatchColours; readonly dark: SwatchColours }) {
  const half = (colours: SwatchColours): CSSProperties => (
    { '--half-page': colours.page, '--half-text': colours.text, '--half-accent': colours.accent } as CSSProperties
  )
  return (
    <span className={css.tile}>
      {[light, dark].map((colours, index) => (
        <span key={index} className={css.tileHalf} style={half(colours)}>
          <span className={css.tileSurface} />
          <span className={css.tileLine} />
          <span className={css.tilePill} />
        </span>
      ))}
    </span>
  )
}

/** The compact live sample: a message, a tool chip, and the input with its accent button, in the given colours. */
function Sample({ copy, light, dark }: { readonly copy: LookSampleCopy; readonly light: SwatchColours; readonly dark: SwatchColours }) {
  const style = { '--l-page': light.page, '--l-text': light.text, '--l-accent': light.accent, '--d-page': dark.page, '--d-text': dark.text, '--d-accent': dark.accent } as CSSProperties
  return (
    <div className={css.sample} style={style} role="img" aria-label={copy.label}>
      <span className={css.mine}>{copy.ask}</span>
      <span className={css.toolChip}>{copy.tool}</span>
      <span className={css.answer}>{copy.answer}</span>
      <span className={css.input}><span>{copy.box}</span><span className={css.send} /></span>
    </div>
  )
}

/** The colour picker and hex input of the custom theme. */
function ColourInputs<Accent extends string>({ custom, disabled }: { readonly custom: CustomPanelProps<Accent>; readonly disabled: boolean }) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? custom.colour
  const valid = custom.isColour(text)
  const commit = (): void => {
    if (draft !== null && custom.isColour(draft) && draft !== custom.colour) custom.onColour(draft)
    setDraft(null)
  }
  return (
    <div className={css.colourRow}>
      <input type="color" className={css.picker} aria-label={custom.colourLabel} disabled={disabled}
        value={valid ? `#${text.replace(/^#/, '')}` : custom.colour}
        onChange={(event) => { setDraft(null); custom.onColour(event.target.value.toUpperCase()) }} />
      <input type="text" className={css.hex} aria-label={custom.hexLabel} aria-invalid={!valid} spellCheck={false} disabled={disabled}
        value={text}
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
      {!valid && <span className={css.error} role="alert">{custom.hexInvalid}</span>}
    </div>
  )
}

/**
 * Render the chooser.
 * @param props - see {@link LookChooserProps}.
 * @returns the chooser with its sample.
 */
export function LookChooser<Mode extends string, Theme extends string, Accent extends string>(props: LookChooserProps<Mode, Theme, Accent>) {
  const { modeLabel, themeLabel, modes, mode, onMode, themes, theme, onTheme, customTheme, custom, sample } = props
  const disabled = props.disabled === true
  const panelId = useId()
  const [peek, setPeek] = useState<Theme | null>(null)
  const shown = themes.find(tile => tile.value === (peek ?? theme)) ?? themes[0]
  return (
    <div className={css.root}>
      <div className={css.choices}>
        {/* The scheme is the browser's own preference, so a read-only settings document does not lock it. */}
        <ChipGroup label={modeLabel} value={mode} variant="segmented" onChange={onMode} options={modes} />
        <ChipGroup label={themeLabel} value={theme} variant="tiles" disabled={disabled} onChange={onTheme} onPeek={setPeek}
          options={themes.map(tile => ({ value: tile.value, label: tile.label, mark: <TileSwatch light={tile.light} dark={tile.dark} /> }))} />
        {theme === customTheme && (
          <div className={css.panel} id={panelId} role="group" aria-label={custom.accentLabel}>
            <AccentPicker label={custom.accentLabel} value={custom.accent} accents={custom.accents} onChange={custom.onAccent} disabled={disabled} />
            <ColourInputs custom={custom} disabled={disabled} />
            {custom.more}
          </div>
        )}
      </div>
      {shown !== undefined && <Sample copy={sample} light={shown.light} dark={shown.dark} />}
    </div>
  )
}
