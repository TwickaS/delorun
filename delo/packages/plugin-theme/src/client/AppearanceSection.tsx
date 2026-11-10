/**
 * Settings → Appearance: the look (Delo's or the stock look), the colour
 * scheme, the palette (Soft or one of T3 Code's themes) and the typeface as
 * preview tiles, the accent as one row of swatches with a custom colour, the
 * density, contrast on a slider, and effort as a name or bars.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ACCENT_CHOICES, CONTRAST, DEFAULT_SETTINGS, DENSITIES, EFFORT_DISPLAYS, PALETTES, TYPEFACES, type AccentChoice, type Density, type PaletteChoice, type ThemeSettings, type Typeface,
} from '../config.ts'
import { formatRgb, fromOklch } from '../palette/color.ts'
import { previewColors, type SchemePreview } from '../palette/layers.ts'
import { ACCENTS, FONT_FAMILIES, parseHex } from '../palette/soft.ts'
import { STOCK_FONT_STACKS } from '../palette/stock.ts'
import css from './AppearanceSection.module.css'
import { ChoiceGroup } from './ChoiceGroup.tsx'

/** The colour-scheme preference, as upstream's theme service keeps it. */
export type SchemePreference = 'light' | 'dark' | 'system'

/** What the section reads and writes. */
export interface AppearanceInjected {
  /** The theme settings, stored by the host half. */
  readonly settings: ConfigForm<ThemeSettings>
  /**
   * Turn Delo's look and every Delo studio plugin off, which withdraws this section.
   * @returns whether the setting was saved.
   */
  readonly useStockLook: () => Promise<boolean>
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
export type AppearanceSectionProps = PropsLocale<'settings.deloAppearance'> & InjectFace<AppearanceInjected>

const SCHEMES: readonly SchemePreference[] = ['light', 'dark', 'system']

/** The looks offered; this section is shown only while Delo's is on. */
const LOOKS = ['delo', 'stock'] as const

/** The font stack each typeface tile shows its specimen in. */
const SPECIMEN_FONTS: Readonly<Record<Typeface, string>> = {
  delo: `'${FONT_FAMILIES.text}', ${STOCK_FONT_STACKS.text}`,
  system: STOCK_FONT_STACKS.text,
}

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

/** The name and help of one setting. */
function Heading({ id, title, lead }: { id: string; title: string; lead: string }) {
  return (
    <div className={css.heading}>
      <h3 id={id} className={css.title}>{title}</h3>
      <p className={css.lead}>{lead}</p>
    </div>
  )
}

/**
 * Render the Appearance section.
 * @param props - the dictionary and the services.
 * @returns the section.
 */
export function AppearanceSection({ t, settings, scheme, useStockLook }: AppearanceSectionProps) {
  // Stable subscribe functions: a new one per render would resubscribe on every render, including after the plugin is disposed.
  const subscribeSettings = useCallback((listener: () => void) => settings.subscribe(listener), [settings])
  const subscribeScheme = useCallback((listener: () => void) => scheme.subscribe(listener), [scheme])
  const snapshot = useSyncExternalStore(subscribeSettings, () => settings.getSnapshot())
  const current = snapshot.value ?? DEFAULT_SETTINGS
  const preference = useSyncExternalStore(subscribeScheme, () => scheme.get())
  const [failed, setFailed] = useState(false)
  const [hex, setHex] = useState(current.customAccent)
  useEffect(() => { setHex(current.customAccent) }, [current.customAccent])
  const disabled = !snapshot.writable
  // The previews draw Delo's look whatever the stored switch says.
  const colours = useMemo(() => previewColors({ ...current, studioAdditions: true }), [current])
  const paletteColours = useMemo(
    () => Object.fromEntries(PALETTES.map(palette => [palette, previewColors({ ...current, palette, studioAdditions: true })])) as Record<PaletteChoice, ReturnType<typeof previewColors>>,
    [current],
  )

  const track = (write: Promise<boolean>): void => {
    setFailed(false)
    void write.then((ok) => { if (!ok) setFailed(true) }, () => { setFailed(true) })
  }
  const save = (field: keyof ThemeSettings, value: unknown): void => { track(settings.set(field, value)) }
  const saveCustom = (value: string): void => {
    const color = parseHex(value)
    if (color === undefined) return
    const normalized = `#${value.trim().replace(/^#/, '').toUpperCase()}`
    save('customAccent', normalized)
  }
  const hexValid = parseHex(hex) !== undefined
  const customColour = parseHex(current.customAccent) === undefined ? DEFAULT_SETTINGS.customAccent : current.customAccent

  return (
    <div className={css.section}>
      <section className={`${css.block} ${css.row}`} aria-labelledby="delo-appearance-look">
        <Heading id="delo-appearance-look" title={t('look')} lead={t('look.lead')} />
        <ChoiceGroup<(typeof LOOKS)[number]> label={t('look')} value="delo" disabled={disabled}
          options={LOOKS.map(look => ({ value: look, label: t(`look.${look}`) }))}
          onChange={() => { track(useStockLook()) }} />
      </section>

      <section className={css.block} aria-labelledby="delo-appearance-mode">
        <Heading id="delo-appearance-mode" title={t('mode')} lead={t('mode.lead')} />
        <div className={css.schemeTiles} role="radiogroup" aria-labelledby="delo-appearance-mode">
          {SCHEMES.map(value => (
            <button key={value} type="button" role="radio" aria-checked={preference === value} className={css.tile} onClick={() => { scheme.set(value) }}>
              {value === 'system'
                ? (
                  <span className={css.mockPair}>
                    <StudioMock colours={colours.light} />
                    <StudioMock colours={colours.dark} className={css.mockDarkHalf} />
                  </span>
                )
                : <StudioMock colours={colours[value]} />}
              <span className={css.tileFoot}>
                <span className={css.tileLabel}>{t(`mode.${value}`)}</span>
                <span className={css.radio} aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className={css.block} aria-labelledby="delo-appearance-palette">
        <Heading id="delo-appearance-palette" title={t('palette')} lead={t('palette.lead')} />
        <div className={css.paletteTiles} role="radiogroup" aria-labelledby="delo-appearance-palette">
          {PALETTES.map(value => (
            <button key={value} type="button" role="radio" aria-checked={current.palette === value} className={css.tile} disabled={disabled}
              onClick={() => { if (current.palette !== value) save('palette', value) }}>
              <span className={css.mockPair}>
                <StudioMock colours={paletteColours[value].light} />
                <StudioMock colours={paletteColours[value].dark} className={css.mockDarkHalf} />
              </span>
              <span className={css.tileFoot}>
                <span className={css.tileLabel}>{t(`palette.${value}`)}</span>
                <span className={css.radio} aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className={css.block} aria-labelledby="delo-appearance-accent" data-muted={current.palette !== 'soft'}>
        <div className={css.row}>
          <Heading id="delo-appearance-accent" title={t('accent')} lead={t(current.palette === 'soft' ? 'accent.lead' : 'accent.byTheme')} />
          <div className={css.accentPicker}>
            <span className={css.accentName} aria-hidden="true">{t(`accent.${current.accent}`)}</span>
            <div className={css.swatches} role="radiogroup" aria-labelledby="delo-appearance-accent">
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

      <section className={css.block} aria-labelledby="delo-appearance-typeface">
        <Heading id="delo-appearance-typeface" title={t('typeface')} lead={t('typeface.lead')} />
        <div className={css.typeTiles} role="radiogroup" aria-labelledby="delo-appearance-typeface">
          {TYPEFACES.map(value => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={current.typeface === value}
              className={css.tile}
              disabled={disabled}
              onClick={() => { if (current.typeface !== value) save('typeface', value) }}
            >
              <span className={css.specimen} style={{ fontFamily: SPECIMEN_FONTS[value] }} aria-hidden="true">
                <span className={css.specimenGlyphs}>Aa</span>
                <span className={css.specimenLine}>{t('typeface.specimen')}</span>
              </span>
              <span className={css.tileFoot}>
                <span className={css.tileLabel}>{t(`typeface.${value}`)}</span>
                <span className={css.radio} aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className={css.block} aria-labelledby="delo-appearance-density">
        <Heading id="delo-appearance-density" title={t('density')} lead={t('density.lead')} />
        <div className={css.densityTiles} role="radiogroup" aria-labelledby="delo-appearance-density">
          {DENSITIES.map((value: Density) => (
            <button key={value} type="button" role="radio" aria-checked={current.density === value}
              className={css.tile} data-density={value} disabled={disabled}
              onClick={() => { if (current.density !== value) save('density', value) }}>
              <span className={css.densityMock} aria-hidden="true"><span /><span /><span /><span /></span>
              <span className={css.tileFoot}>
                <span className={css.tileLabel}>{t(`density.${value}`)}</span>
                <span className={css.radio} aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className={`${css.block} ${css.row}`} aria-labelledby="delo-appearance-contrast">
        <Heading id="delo-appearance-contrast" title={t('contrast')} lead={t('contrast.lead')} />
        <ContrastSlider value={current.contrast} disabled={disabled} label={t('contrast')} onCommit={(value) => { save('contrast', value) }} />
      </section>

      <section className={`${css.block} ${css.row}`} aria-labelledby="delo-appearance-effort">
        <Heading id="delo-appearance-effort" title={t('effort')} lead={t('effort.lead')} />
        <ChoiceGroup label={t('effort')} value={current.effort} disabled={disabled}
          options={EFFORT_DISPLAYS.map(display => ({ value: display, label: t(`effort.${display}`) }))}
          onChange={(display) => { save('effort', display) }} />
      </section>

      {failed && <p className={css.failure} role="alert">{t('saveFailed')}</p>}
    </div>
  )
}
