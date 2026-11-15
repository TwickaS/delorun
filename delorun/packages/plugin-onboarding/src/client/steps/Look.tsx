/**
 * Look: colour scheme, theme and accent, with a chat that shows the choice, and a quiet line for the stock look.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ACCENT_PRESETS, ACCENT_PREVIEWS, PALETTE_CHOICES, PALETTE_PREVIEWS } from '../previews.ts'
import type { SchemePreference, StepServices } from '../types.ts'
import { AccentPicker, ChipGroup, ThemePicker } from '@delorun/plugin-theme/controls'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StepProps } from './shared.ts'
import css from './steps.module.css'

/** The colour schemes the look step offers. */
const SCHEMES: readonly SchemePreference[] = ['light', 'dark', 'system']

/**
 * A small chat in the chosen look: a message of the person's, the agent's answer with a tool line, and the message
 * box. It draws with the studio's own colour tokens, so each choice shows in it at once.
 * @param props - this plugin's copy.
 * @returns the preview.
 */
function ChatPreview({ t }: { readonly t: StepServices['t'] }): ReactNode {
  return (
    <div className={css.preview} role="img" aria-label={t('look.preview')}>
      <span className={css.bubbleMine}>{t('look.preview.ask')}</span>
      <span className={css.bubbleAgent}>
        <span className={css.toolLine}>{t('look.preview.tool')}</span>
        {t('look.preview.answer')}
      </span>
      <span className={css.composer}><span>{t('look.preview.box')}</span><span className={css.send} /></span>
    </div>
  )
}

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
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { setAsking(true) }}>{appearance('look.stock')}</Button>
      </p>
    )
  }
  return (
    <div className={css.stack} role="group" aria-label={t('look.studio')}>
      <p className={css.hint}>{t('look.stock.confirm')}</p>
      <div className={css.actions}>
        <Button ref={yes} variant="outline" size="sm" onClick={onConfirm}>{t('look.stock.yes')}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setAsking(false) }}>{t('look.stock.no')}</Button>
      </div>
    </div>
  )
}

/**
 * Look: colour scheme, theme and accent, with a chat that shows the choice, and a quiet line for the stock look.
 * @param props - the services.
 * @returns the step body.
 */
export function LookStep({ services }: StepProps): ReactNode {
  const { t, appearance, scheme, look } = services
  const preference = useSyncExternalStore(useCallback(listener => scheme.subscribe(listener), [scheme]), () => scheme.get())
  const settings = useSyncExternalStore(useCallback(listener => look.settings.subscribe(listener), [look]), () => look.settings.getSnapshot())
  const [failed, setFailed] = useState(false)
  const palette = settings.value?.palette ?? 'soft'
  const accent = settings.value?.accent ?? 'peach'
  const save = (write: Promise<boolean>): void => {
    setFailed(false)
    write.then((ok) => { if (!ok) setFailed(true) }, () => { setFailed(true) })
  }
  const disabled = !settings.writable
  return (
    <div className={css.lookGrid}>
      <div className={css.stack}>
        <p className={css.lead}>{t('look.lead')}</p>
        <ChipGroup label={appearance('mode')} value={preference} onChange={(value) => { scheme.set(value) }}
          options={SCHEMES.map(value => ({ value, label: appearance(`mode.${value}`) }))} />
        <ThemePicker label={appearance('palette')} value={palette} disabled={disabled}
          onChange={(value) => { save(look.settings.set('palette', value)) }}
          themes={PALETTE_CHOICES.map(value => ({ value, label: appearance(`palette.${value}`), light: PALETTE_PREVIEWS[value].light, dark: PALETTE_PREVIEWS[value].dark }))} />
        <AccentPicker label={appearance('accent')} value={accent} disabled={disabled || palette !== 'soft'}
          onChange={(value) => { save(look.settings.set('accent', value)) }}
          accents={ACCENT_PRESETS.map(value => ({ value, label: appearance(`accent.${value}`), light: ACCENT_PREVIEWS[value].light, dark: ACCENT_PREVIEWS[value].dark }))} />
        {palette !== 'soft' && <p className={css.hint}>{appearance('accent.byTheme')}</p>}
        {failed && <p className={css.failure} role="alert">{t('saveFailed')}</p>}
        <StockLookLine t={t} appearance={appearance} disabled={disabled} onConfirm={() => { save(look.useStockLook()) }} />
      </div>
      <ChatPreview t={t} />
    </div>
  )
}
