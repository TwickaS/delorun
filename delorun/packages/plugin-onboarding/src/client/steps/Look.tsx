/**
 * Look: colour scheme and theme in one chooser with a compact live sample, and a quiet line for the stock look.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ACCENT_PRESETS, ACCENT_PREVIEWS, customStart, lookView, PALETTE_CHOICES, PALETTE_PREVIEWS, type LookValues, type PaletteChoice } from '../previews.ts'
import type { SchemePreference, StepServices } from '../types.ts'
import { LookChooser, type LookSampleCopy } from '@delorun/brand'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StepProps } from './shared.ts'
import css from './steps.module.css'

/** The colour schemes the look step offers. */
const SCHEMES: readonly SchemePreference[] = ['light', 'dark', 'system']

/**
 * The stock look as a quiet line under the choices. Choosing it asks first, because it turns Delorun's studio additions
 * off and closes the guide.
 * @param props - this plugin's copy, whether the settings can be written and what confirms the switch.
 * @returns the line, or the question.
 */
function StockLookLine({ t, appearance, disabled, onConfirm }: { readonly t: StepServices['t']; readonly appearance: StepServices['appearance']; readonly disabled: boolean; readonly onConfirm: () => void }): ReactNode {
  const [asking, setAsking] = useState(false)
  const yes = useRef<HTMLButtonElement>(null)
  // The question replaces the button that was pressed, so focus moves to its first answer.
  useEffect(() => { if (asking) yes.current?.focus() }, [asking])
  if (!asking) {
    return (
      <p className={css.hint}>
        {t('look.stock.ask')}{' '}
        <Button className={css.stockLink} variant="ghost" size="sm" disabled={disabled} onClick={() => { setAsking(true) }}>{appearance('look.stock')}</Button>
      </p>
    )
  }
  return (
    <div className={css.stack} role="group" aria-label={t('look.studio')}>
      <p className={css.hint}>{t('look.stock.confirm')}</p>
      <div className={css.actions}>
        <Button ref={yes} className={css.stockLink} variant="outline" size="sm" onClick={onConfirm}>{t('look.stock.yes')}</Button>
        <Button className={css.stockLink} variant="ghost" size="sm" onClick={() => { setAsking(false) }}>{t('look.stock.no')}</Button>
      </div>
    </div>
  )
}

/** The sample's copy. */
function sampleCopy(t: StepServices['t']): LookSampleCopy {
  return { label: t('look.preview'), ask: t('look.preview.ask'), tool: t('look.preview.tool'), answer: t('look.preview.answer'), box: t('look.preview.box') }
}

/** A custom colour as the CSS colour its swatch is drawn in. */
const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * Look: colour scheme and theme in one chooser with a compact live sample, and a quiet line for the stock look. Only the
 * Custom theme shows the accent pickers.
 * @param props - the services.
 * @returns the step body.
 */
export function LookStep({ services }: StepProps): ReactNode {
  const { t, appearance, scheme, look } = services
  const preference = useSyncExternalStore(useCallback(listener => scheme.subscribe(listener), [scheme]), () => scheme.get())
  const settings = useSyncExternalStore(useCallback(listener => look.settings.subscribe(listener), [look]), () => look.settings.getSnapshot())
  const [failed, setFailed] = useState(false)
  const stored: LookValues = {
    palette: settings.value?.palette ?? 'soft', accent: settings.value?.accent ?? 'peach',
    customAccent: settings.value?.customAccent ?? '#E5734A', contrast: settings.value?.contrast ?? 100,
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
  const customColour = HEX.test(view.customAccent) ? view.customAccent : '#E5734A'
  const accentFill = view.accent === 'custom' ? customColour : ACCENT_PREVIEWS[view.accent].light
  const customTile = {
    light: { ...PALETTE_PREVIEWS.soft.light, accent: accentFill },
    dark: { ...PALETTE_PREVIEWS.soft.dark, accent: view.accent === 'custom' ? customColour : ACCENT_PREVIEWS[view.accent].dark },
  }
  return (
    <div className={css.stack}>
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
      <StockLookLine t={t} appearance={appearance} disabled={disabled} onConfirm={() => { save(look.useStockLook()) }} />
    </div>
  )
}
