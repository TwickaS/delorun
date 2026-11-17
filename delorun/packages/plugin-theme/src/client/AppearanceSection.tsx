/**
 * The Appearance section, one card headed "Colours": the colour scheme and
 * the theme (Soft or one of Delorun's themes), the accent with a custom colour, and contrast on a slider. The choices
 * are the shared chips of `@delorun/brand`, which onboarding's Look step also renders.
 */
import { useCallback, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ACCENT_CHOICES, CONTRAST, DEFAULT_SETTINGS, PALETTES, type AccentChoice, type PaletteChoice, type ThemeSettings } from '../config.ts'
import { writesFor, type CustomValues, type ThemeChange } from '../settings.ts'
import { formatRgb, fromOklch } from '../palette/color.ts'
import { previewColors } from '../palette/layers.ts'
import { lookOf } from '../palette/migrate.ts'
import { ACCENTS, parseHex } from '../palette/soft.ts'
import css from './AppearanceSection.module.css'
import { useFormWrites } from './form-writes.ts'
import { cardCss, LookChooser, SettingHeading, SettingsCard } from '@delorun/brand'
import { BrandingSection, type BrandingInjected } from './BrandingSection.tsx'

/** The colour-scheme preference, as upstream's theme service keeps it. */
export type SchemePreference = 'light' | 'dark' | 'system'

/** What the section reads and writes. */
export interface AppearanceInjected {
  /** The theme settings, stored by the host half. */
  readonly settings: ConfigForm<ThemeSettings>
  /** The Branding block's translate function. */
  readonly brandingT: PropsLocale<'settings.delorunBranding'>['t']
  /** The icon picker's translate function. */
  readonly pickerT: BrandingInjected['pickerT']
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

/** A preset accent's dot fill in each scheme. */
function presetFill(choice: Exclude<AccentChoice, 'custom'>): { readonly light: string; readonly dark: string } {
  const accent = ACCENTS[choice]
  const fill = (l: number): string => formatRgb(fromOklch({ l, c: accent.chroma, h: accent.hue, alpha: 1 }))
  return { light: fill(accent.fill.light), dark: fill(accent.fill.dark) }
}

/**
 * The contrast slider: 50 to 200, with a notch at 100 that names its value only while the slider is elsewhere, so the value never shows twice; the setting is saved when the slider is let go.
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
          style={{ '--range-fill': `${String(((shown - CONTRAST.min) / (CONTRAST.max - CONTRAST.min)) * 100)}%` } as CSSProperties}
          onChange={(event) => { setDraft(Number(event.currentTarget.value)) }}
          onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
        <button type="button" className={css.notch} disabled={disabled} aria-pressed={value === CONTRAST.default}
          aria-label={`${String(CONTRAST.default)}%`}
          style={{ left: `${String(((CONTRAST.default - CONTRAST.min) / (CONTRAST.max - CONTRAST.min)) * 100)}%` }}
          onClick={() => { if (value !== CONTRAST.default) onCommit(CONTRAST.default) }}>
          {shown === CONTRAST.default ? null : `${String(CONTRAST.default)}%`}
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
export function AppearanceSection({ t, settings, scheme, brandingT, pickerT }: AppearanceSectionProps) {
  const { snapshot, disabled, failed, track } = useFormWrites(settings)
  // A stable subscribe function: a new one per render would resubscribe on every render, including after the plugin is disposed.
  const subscribeScheme = useCallback((listener: () => void) => scheme.subscribe(listener), [scheme])
  const stored = snapshot.value ?? DEFAULT_SETTINGS
  // Settings stored before presets and the custom theme were separate read as the custom theme they drew.
  const current = lookOf(stored)
  const preference = useSyncExternalStore(subscribeScheme, () => scheme.get())
  // The tiles draw Delorun's look whatever the stored switch says; the custom tile draws the custom values.
  const colours = useMemo(
    () => Object.fromEntries(PALETTES.map(palette => [palette, previewColors({ ...current, palette, studioAdditions: true })])) as Record<PaletteChoice, ReturnType<typeof previewColors>>,
    [current],
  )

  // The writes come from `writesFor`, which the website's setup strip also calls, so the entry it shows is this one.
  const write = (change: ThemeChange): void => { track(settings.mutate(writesFor(change, current))) }
  const writeCustom = (values: Partial<CustomValues>): void => { write({ kind: 'custom', values }) }
  const choosePalette = (palette: PaletteChoice): void => { write({ kind: 'palette', palette }) }
  const customColour = parseHex(current.customAccent) === undefined ? DEFAULT_SETTINGS.customAccent : current.customAccent

  return (
    <div className={cardCss.stack}>
    <SettingsCard id="delorun-appearance-colours" title={t('colours')} className={css.section}>
      <section className={cardCss.block}>
        <SettingHeading id="delorun-appearance-palette" title={t('palette')} lead={t('palette.lead')} />
        <LookChooser
          modeLabel={t('mode')} themeLabel={t('palette')} disabled={disabled}
          modes={SCHEMES.map(value => ({ value, label: t(`mode.${value}`) }))} mode={preference} onMode={(value) => { scheme.set(value) }}
          themes={PALETTES.map(value => ({ value, label: t(`palette.${value}`), light: colours[value].light, dark: colours[value].dark }))}
          theme={current.palette} onTheme={choosePalette} customTheme="custom"
          sample={{ label: t('preview'), ask: t('preview.ask'), answer: t('preview.answer'), box: t('preview.box') }}
          custom={{
            accentLabel: t('accent'), accent: current.accent, onAccent: (value) => { writeCustom({ accent: value }) },
            accents: ACCENT_CHOICES.map(choice => ({
              value: choice,
              label: t(`accent.${choice}`),
              ...choice === 'custom' ? { light: customColour, dark: customColour } : presetFill(choice),
            })),
            colourLabel: t('accent.customColor'), hexLabel: t('accent.hex'), hexInvalid: t('accent.hexInvalid'),
            colour: customColour, onColour: (value) => { writeCustom({ accent: 'custom', customAccent: value.toUpperCase() }) },
            isColour: text => parseHex(text) !== undefined,
            more: (
              <div className={css.contrastRow}>
                <span className={css.contrastLabel}>{t('contrast')}</span>
                <ContrastSlider value={current.contrast} disabled={disabled} label={t('contrast')} onCommit={(value) => { writeCustom({ contrast: value }) }} />
              </div>
            ),
          }} />
      </section>

      {failed && <p className={cardCss.failure} role="alert">{t('saveFailed')}</p>}
    </SettingsCard>
    <BrandingSection t={brandingT} settings={settings} pickerT={pickerT} />
    </div>
  )
}
