/**
 * The Appearance section, one card headed "Colours": the colour scheme and
 * the palette (Soft or one of T3 Code's themes) as preview tiles, the accent
 * as one row of swatches with a custom colour, and contrast on a slider.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ACCENT_CHOICES, CONTRAST, DEFAULT_SETTINGS, PALETTES, type AccentChoice, type PaletteChoice, type ThemeSettings } from '../config.ts'
import { formatRgb, fromOklch } from '../palette/color.ts'
import { previewColors, type SchemePreview } from '../palette/layers.ts'
import { ACCENTS, parseHex } from '../palette/soft.ts'
import css from './AppearanceSection.module.css'
import { useFormWrites } from './form-writes.ts'
import { cardCss, SettingHeading, SettingsCard, TileGroup } from '@delorun/settings-controls'

/** The colour-scheme preference, as upstream's theme service keeps it. */
export type SchemePreference = 'light' | 'dark' | 'system'

/** What the section reads and writes. */
export interface AppearanceInjected {
  /** The theme settings, stored by the host half. */
  readonly settings: ConfigForm<ThemeSettings>
  /** Upstream's colour-scheme preference. */
  readonly scheme: {
    /** @returns the current preference. */
    get(): SchemePreference
    /**
     * Follow changes.
     * @param listener - called after each change.
     * @returns the unsubscriber.
     */
    subscribe(listener: () => void): () => void
    /**
     * Choose a preference.
     * @param preference - the new preference.
     */
    set(preference: SchemePreference): void
  }
}

/** The props the section reads: its dictionary and its injected services. */
export type AppearanceSectionProps = PropsLocale<'settings.delorunAppearance'> & InjectFace<AppearanceInjected>

const SCHEMES: readonly SchemePreference[] = ['light', 'dark', 'system']

/** A preset's swatch colours, its fill in each scheme, as custom properties. */
function presetSwatch(choice: Exclude<AccentChoice, 'custom'>): CSSProperties {
  const accent = ACCENTS[choice]
  const fill = (l: number): string => formatRgb(fromOklch({ l, c: accent.chroma, h: accent.hue, alpha: 1 }))
  return { '--chip-light': fill(accent.fill.light), '--chip-dark': fill(accent.fill.dark) } as CSSProperties
}

/** A scheme preview's colours as the mock's custom properties. */
function mockColours(colours: SchemePreview): CSSProperties {
  return {
    '--mock-page': colours.page,
    '--mock-sidebar': colours.sidebar,
    '--mock-layer': colours.layer,
    '--mock-text': colours.text,
    '--mock-quiet': colours.quiet,
    '--mock-accent': colours.accent,
  } as CSSProperties
}

/** The light studio with the dark one over its right half, for a choice that covers both schemes. */
function SchemePair({ light, dark }: { light: SchemePreview; dark: SchemePreview }) {
  return (
    <span className={css.mockPair}>
      <StudioMock colours={light} />
      <StudioMock colours={dark} className={css.mockDarkHalf} />
    </span>
  )
}

/** A miniature studio in one scheme: a sidebar of rows, a reply and the composer with its send button. */
function StudioMock({ colours, className }: { colours: SchemePreview; className?: string | undefined }) {
  return (
    <span className={className === undefined ? css.mock : `${css.mock} ${className}`} style={mockColours(colours)} aria-hidden="true">
      <span className={css.mockSidebar}>
        <span className={css.mockRowActive} />
        <span className={css.mockRow} />
        <span className={css.mockRow} />
      </span>
      <span className={css.mockMain}>
        <span className={css.mockLine} />
        <span className={css.mockLineShort} />
        <span className={css.mockComposer}><span className={css.mockSend} /></span>
      </span>
    </span>
  )
}

/**
 * The contrast slider: T3 Code's 50 to 200, with a notch at 100; the setting is saved when the slider is let go.
 * @param props - the saved value, whether it is disabled, the label and the save.
 * @returns the slider.
 */
function ContrastSlider({ value, disabled, label, onCommit }: {
  readonly value: number
  readonly disabled: boolean
  readonly label: string
  readonly onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  const commit = (): void => {
    if (draft !== null && draft !== value) onCommit(draft)
    setDraft(null)
  }
  return (
    <div className={css.slider}>
      <span className={css.sliderValue} aria-hidden="true">{`${String(shown)}%`}</span>
      <div className={css.sliderTrack}>
        <input type="range" aria-label={label} aria-valuetext={`${String(shown)}%`} disabled={disabled}
          min={CONTRAST.min} max={CONTRAST.max} step={CONTRAST.step} value={shown}
          onChange={(event) => { setDraft(Number(event.currentTarget.value)) }}
          onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
        <button type="button" className={css.notch} disabled={disabled} aria-pressed={value === CONTRAST.default}
          style={{ left: `${String(((CONTRAST.default - CONTRAST.min) / (CONTRAST.max - CONTRAST.min)) * 100)}%` }}
          onClick={() => { if (value !== CONTRAST.default) onCommit(CONTRAST.default) }}>
          {String(CONTRAST.default)}
        </button>
      </div>
    </div>
  )
}

/**
 * Render the Appearance section.
 * @param props - the dictionary and the services.
 * @returns the section.
 */
export function AppearanceSection({ t, settings, scheme }: AppearanceSectionProps) {
  const { snapshot, disabled, failed, save } = useFormWrites(settings)
  // A stable subscribe function: a new one per render would resubscribe on every render, including after the plugin is disposed.
  const subscribeScheme = useCallback((listener: () => void) => scheme.subscribe(listener), [scheme])
  const current = snapshot.value ?? DEFAULT_SETTINGS
  const preference = useSyncExternalStore(subscribeScheme, () => scheme.get())
  const [hex, setHex] = useState(current.customAccent)
  useEffect(() => { setHex(current.customAccent) }, [current.customAccent])
  // The previews draw Delorun's look whatever the stored switch says.
  const colours = useMemo(() => previewColors({ ...current, studioAdditions: true }), [current])
  const paletteColours = useMemo(
    () => Object.fromEntries(PALETTES.map(palette => [palette, previewColors({ ...current, palette, studioAdditions: true })])) as Record<PaletteChoice, ReturnType<typeof previewColors>>,
    [current],
  )

  const saveCustom = (value: string): void => {
    const color = parseHex(value)
    if (color === undefined) return
    const normalized = `#${value.trim().replace(/^#/, '').toUpperCase()}`
    save('customAccent', normalized)
  }
  const hexValid = parseHex(hex) !== undefined
  const customColour = parseHex(current.customAccent) === undefined ? DEFAULT_SETTINGS.customAccent : current.customAccent

  return (
    <SettingsCard id="delorun-appearance-colours" title={t('colours')} className={css.section}>
      <section className={cardCss.block} aria-labelledby="delorun-appearance-mode">
        <SettingHeading id="delorun-appearance-mode" title={t('mode')} lead={t('mode.lead')} />
        <TileGroup labelledBy="delorun-appearance-mode" className={css.schemeTiles} value={preference} disabled={false}
          onChange={(value) => { scheme.set(value) }}
          tiles={SCHEMES.map(value => ({
            value,
            label: t(`mode.${value}`),
            preview: value === 'system' ? <SchemePair light={colours.light} dark={colours.dark} /> : <StudioMock colours={colours[value]} />,
          }))} />
      </section>

      <section className={cardCss.block} aria-labelledby="delorun-appearance-palette">
        <SettingHeading id="delorun-appearance-palette" title={t('palette')} lead={t('palette.lead')} />
        <TileGroup labelledBy="delorun-appearance-palette" className={css.paletteTiles} value={current.palette} disabled={disabled}
          onChange={(value) => { save('palette', value) }}
          tiles={PALETTES.map(value => ({
            value,
            label: t(`palette.${value}`),
            preview: <SchemePair light={paletteColours[value].light} dark={paletteColours[value].dark} />,
          }))} />
      </section>

      <section className={cardCss.block} aria-labelledby="delorun-appearance-accent" data-muted={current.palette !== 'soft'}>
        <div className={cardCss.row}>
          <SettingHeading id="delorun-appearance-accent" title={t('accent')} lead={t(current.palette === 'soft' ? 'accent.lead' : 'accent.byTheme')} />
          <div className={css.accentPicker}>
            <span className={css.accentName} aria-hidden="true">{t(`accent.${current.accent}`)}</span>
            <div className={css.swatches} role="radiogroup" aria-labelledby="delorun-appearance-accent">
              {ACCENT_CHOICES.map(choice => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={current.accent === choice}
                  aria-label={t(`accent.${choice}`)}
                  title={t(`accent.${choice}`)}
                  className={css.swatch}
                  disabled={disabled}
                  onClick={() => { if (current.accent !== choice) save('accent', choice) }}
                >
                  {choice === 'custom'
                    ? <span className={`${css.dot} ${css.customDot}`} style={{ '--custom': customColour } as CSSProperties} />
                    : <span className={css.dot} style={presetSwatch(choice)} />}
                </button>
              ))}
            </div>
          </div>
        </div>
        {current.accent === 'custom' && (
          <div className={css.customRow}>
            <input
              type="color"
              className={css.picker}
              aria-label={t('accent.customColor')}
              value={hexValid ? `#${hex.replace(/^#/, '')}` : DEFAULT_SETTINGS.customAccent}
              disabled={disabled}
              onChange={(event) => { setHex(event.target.value.toUpperCase()); saveCustom(event.target.value) }}
            />
            <input
              type="text"
              className={css.hex}
              aria-label={t('accent.hex')}
              aria-invalid={!hexValid}
              spellCheck={false}
              value={hex}
              disabled={disabled}
              onChange={(event) => { setHex(event.target.value) }}
              onBlur={() => { saveCustom(hex) }}
              onKeyDown={(event) => { if (event.key === 'Enter') saveCustom(hex) }}
            />
            {!hexValid && <span className={css.error}>{t('accent.hexInvalid')}</span>}
          </div>
        )}
      </section>

      <section className={`${cardCss.block} ${cardCss.row}`} aria-labelledby="delorun-appearance-contrast">
        <SettingHeading id="delorun-appearance-contrast" title={t('contrast')} lead={t('contrast.lead')} />
        <ContrastSlider value={current.contrast} disabled={disabled} label={t('contrast')} onCommit={(value) => { save('contrast', value) }} />
      </section>

      {failed && <p className={cardCss.failure} role="alert">{t('saveFailed')}</p>}
    </SettingsCard>
  )
}
