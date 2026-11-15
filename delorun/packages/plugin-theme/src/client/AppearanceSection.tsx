/**
 * The Appearance section, one card headed "Colours": the colour scheme and
 * the theme (Soft or one of Delorun's themes), the accent with a custom colour, and contrast on a slider. The choices
 * are the shared chips of `./controls`, which onboarding's Look step also renders.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ACCENT_CHOICES, CONTRAST, DEFAULT_SETTINGS, PALETTES, type AccentChoice, type PaletteChoice, type ThemeSettings } from '../config.ts'
import { formatRgb, fromOklch } from '../palette/color.ts'
import { previewColors } from '../palette/layers.ts'
import { ACCENTS, parseHex } from '../palette/soft.ts'
import css from './AppearanceSection.module.css'
import { useFormWrites } from './form-writes.ts'
import { cardCss, SettingHeading, SettingsCard } from '@delorun/settings-controls'
import { AccentPicker, ChipGroup, ThemePicker } from './controls/index.ts'

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

/** A preset accent's dot fill in each scheme. */
function presetFill(choice: Exclude<AccentChoice, 'custom'>): { readonly light: string; readonly dark: string } {
  const accent = ACCENTS[choice]
  const fill = (l: number): string => formatRgb(fromOklch({ l, c: accent.chroma, h: accent.hue, alpha: 1 }))
  return { light: fill(accent.fill.light), dark: fill(accent.fill.dark) }
}

/**
 * The contrast slider: 50 to 200, with a notch at 100; the setting is saved when the slider is let go.
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
      <section className={cardCss.block}>
        <SettingHeading id="delorun-appearance-mode" title={t('mode')} lead={t('mode.lead')} />
        <ChipGroup label={t('mode')} hideLabel value={preference} onChange={(value) => { scheme.set(value) }}
          options={SCHEMES.map(value => ({ value, label: t(`mode.${value}`) }))} />
      </section>

      <section className={cardCss.block}>
        <SettingHeading id="delorun-appearance-palette" title={t('palette')} lead={t('palette.lead')} />
        <ThemePicker label={t('palette')} value={current.palette} disabled={disabled} onChange={(value) => { save('palette', value) }}
          themes={PALETTES.map(value => ({ value, label: t(`palette.${value}`), light: paletteColours[value].light, dark: paletteColours[value].dark }))} />
      </section>

      <section className={cardCss.block} data-muted={current.palette !== 'soft'}>
        <SettingHeading id="delorun-appearance-accent" title={t('accent')} lead={t(current.palette === 'soft' ? 'accent.lead' : 'accent.byTheme')} />
        <AccentPicker label={t('accent')} value={current.accent} disabled={disabled || current.palette !== 'soft'} onChange={(value) => { save('accent', value) }}
          accents={ACCENT_CHOICES.map(choice => ({
            value: choice,
            label: t(`accent.${choice}`),
            ...choice === 'custom' ? { light: customColour, dark: customColour } : presetFill(choice),
          }))} />
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
