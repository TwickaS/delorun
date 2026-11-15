/**
 * Look: colour scheme, theme, accent and the choice of Delorun's look or the stock look, with a chat that shows the choice.
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ACCENT_PRESETS, ACCENT_PREVIEWS, PALETTE_CHOICES, PALETTE_PREVIEWS } from '../previews.ts'
import type { SchemePreference, StepServices } from '../types.ts'
import { Choices, PaletteSwatch } from '../ui/ChoiceChip.tsx'
import chip from '../ui/ChoiceChip.module.css'
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
 * Look: colour scheme, theme, accent and the choice of Delorun's look or the stock look, with a chat that shows the choice.
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
        <Choices label={appearance('mode')} options={SCHEMES.map(value => ({
          key: value, checked: preference === value, onSelect: () => { scheme.set(value) }, content: appearance(`mode.${value}`),
        }))} />
        <Choices label={appearance('palette')} options={PALETTE_CHOICES.map(value => ({
          key: value, checked: palette === value, disabled,
          onSelect: () => { if (palette !== value) save(look.settings.set('palette', value)) },
          content: (
            <>
              <PaletteSwatch light={PALETTE_PREVIEWS[value].light} dark={PALETTE_PREVIEWS[value].dark} />
              {appearance(`palette.${value}`)}
            </>
          ),
        }))} />
        {palette === 'soft'
          ? (
            <Choices label={appearance('accent')} options={ACCENT_PRESETS.map(value => ({
              key: value, checked: accent === value, disabled,
              onSelect: () => { if (accent !== value) save(look.settings.set('accent', value)) },
              content: (
                <>
                  <span className={chip.accentDot} aria-hidden="true"
                    style={{ '--accent-light': ACCENT_PREVIEWS[value].light, '--accent-dark': ACCENT_PREVIEWS[value].dark } as CSSProperties} />
                  {appearance(`accent.${value}`)}
                </>
              ),
            }))} />
          )
          : <p className={css.hint}>{appearance('accent.byTheme')}</p>}
        <Choices label={t('look.studio')} manual options={[
          { key: 'delorun', checked: true, disabled, onSelect: () => {}, content: appearance('look.delorun') },
          { key: 'stock', checked: false, disabled, onSelect: () => { save(look.useStockLook()) }, content: appearance('look.stock') },
        ]} />
        <p className={css.hint}>{t('look.studio.lead')}</p>
        {failed && <p className={css.failure} role="alert">{t('saveFailed')}</p>}
      </div>
      <ChatPreview t={t} />
    </div>
  )
}
