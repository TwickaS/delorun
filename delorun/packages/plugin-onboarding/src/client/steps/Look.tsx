/**
 * Look: colour scheme and theme in one chooser with a compact live sample, and a quiet line for the stock look.
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ACCENT_PRESETS, ACCENT_PREVIEWS, customStart, lookView, PALETTE_CHOICES, PALETTE_PREVIEWS, type LookValues, type PaletteChoice } from '../previews.ts'
import type { SchemePreference, StepServices } from '../types.ts'
import { LookChooser, type LookSampleCopy } from '@delorun/brand'
import { BRAND_COLOURS } from '@delorun/brand/tokens'
import { useStore, type StepProps } from './shared.ts'
import { StockLookLink, StockLookScreen } from './StockLook.tsx'
import css from './steps.module.css'

/** The colour schemes the look step offers. */
const SCHEMES: readonly SchemePreference[] = ['light', 'dark', 'system']

/** The sample's copy. */
function sampleCopy(t: StepServices['t']): LookSampleCopy {
  return { label: t('look.preview'), ask: t('look.preview.ask'), answer: t('look.preview.answer'), box: t('look.preview.box') }
}

/** A custom colour as the CSS colour its swatch is drawn in. */
const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * Look: colour scheme and theme in one chooser with a compact live sample, and a quiet link to the original-look screen.
 * Only the Custom theme shows the accent pickers.
 * @param props - the services, the guide and what continues to the next step.
 * @returns the step body.
 */
export function LookStep({ services, guide, next }: StepProps & { readonly next: () => void }): ReactNode {
  const { t, appearance, scheme, look } = services
  const screen = useStore(guide.stockScreen)
  const preference = useSyncExternalStore(useCallback(listener => scheme.subscribe(listener), [scheme]), () => scheme.get())
  const settings = useSyncExternalStore(useCallback(listener => look.settings.subscribe(listener), [look]), () => look.settings.getSnapshot())
  const [failed, setFailed] = useState(false)
  const stored: LookValues = {
    palette: settings.value?.palette ?? 'soft', accent: settings.value?.accent ?? 'peach',
    customAccent: settings.value?.customAccent ?? BRAND_COLOURS.peach, contrast: settings.value?.contrast ?? 100,
  }
  const view = lookView(stored)
  const save = (write: Promise<boolean>): void => {
    setFailed(false)
    write.then((ok) => { if (!ok) setFailed(true) }, () => { setFailed(true) })
  }
  const disabled = !settings.writable
  const writeCustom = (patch: Partial<Pick<LookValues, 'accent' | 'customAccent'>>): void => {
    const next = { ...customStart(view), ...patch }
    save(look.settings.mutate([
      { op: 'set', path: ['accent'], value: next.accent },
      { op: 'set', path: ['customAccent'], value: next.customAccent },
      { op: 'set', path: ['contrast'], value: next.contrast },
      { op: 'set', path: ['palette'], value: 'custom' },
    ]))
  }
  const customColour = HEX.test(view.customAccent) ? view.customAccent : BRAND_COLOURS.peach
  const accentFill = view.accent === 'custom' ? customColour : ACCENT_PREVIEWS[view.accent].light
  if (screen) return <StockLookScreen services={services} guide={guide} next={next} />
  const customTile = {
    light: { ...PALETTE_PREVIEWS.soft.light, accent: accentFill },
    dark: { ...PALETTE_PREVIEWS.soft.dark, accent: view.accent === 'custom' ? customColour : ACCENT_PREVIEWS[view.accent].dark },
  }
  return (
    <div className={`${css.stack} ${css.lookFill}`}>
      <p className={css.lead}>{t('look.lead')}</p>
      <LookChooser
        modeLabel={appearance('mode')} themeLabel={appearance('palette')} disabled={disabled}
        modes={SCHEMES.map(value => ({ value, label: appearance(`mode.${value}`) }))} mode={preference} onMode={(value) => { scheme.set(value) }}
        themes={[
          ...PALETTE_CHOICES.map(value => ({ value: value as PaletteChoice, label: appearance(`palette.${value}`), light: PALETTE_PREVIEWS[value].light, dark: PALETTE_PREVIEWS[value].dark })),
          { value: 'custom' as PaletteChoice, label: appearance('palette.custom'), ...customTile },
        ]}
        theme={view.palette}
        onTheme={(value) => { if (value === 'custom') writeCustom({}); else save(look.settings.set('palette', value)) }}
        customTheme="custom" sample={sampleCopy(t)}
        custom={{
          accentLabel: appearance('accent'), accent: view.accent, onAccent: (value) => { writeCustom({ accent: value }) },
          accents: [
            ...ACCENT_PRESETS.map(value => ({ value: value as LookValues['accent'], label: appearance(`accent.${value}`), light: ACCENT_PREVIEWS[value].light, dark: ACCENT_PREVIEWS[value].dark })),
            { value: 'custom', label: appearance('accent.custom'), light: customColour, dark: customColour },
          ],
          colourLabel: appearance('accent.customColor'), hexLabel: appearance('accent.hex'), hexInvalid: appearance('accent.hexInvalid'),
          colour: customColour, onColour: (value) => { writeCustom({ accent: 'custom', customAccent: value.toUpperCase() }) },
          isColour: text => HEX.test(text),
        }} />
      {failed && <p className={css.failure} role="alert">{t('saveFailed')}</p>}
      <div className={css.closing}><StockLookLink services={services} guide={guide} disabled={false} /></div>
    </div>
  )
}
