/**
 * Welcome: the language as large tiles, a small picture of the studio drawn in the chosen language, and the preview
 * notice while it is owed, with its longer text behind "Read more".
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { NoticeFace, StepServices } from '../types.ts'
import { COVERED_LOCALES, DICTIONARIES } from '../locales.ts'
import { ChipGroup } from '@delorun/brand'
import { Notice } from '../ui/Notice.tsx'
import type { StepProps } from './shared.ts'
import css from './steps.module.css'
import welcome from './welcome.module.css'

/**
 * A tile's line in its own language, so a person who cannot read the active language still finds theirs.
 * @param id - the locale id.
 * @returns the line, or undefined for a locale this plugin's copy does not cover.
 */
function ownLine(id: string): string | undefined {
  return id in DICTIONARIES ? DICTIONARIES[id as keyof typeof DICTIONARIES]['welcome.language.own'] : undefined
}

/**
 * The studio in miniature: a sidebar with a few chats beside one exchange (on a phone, three, so the picture fills the step), in the active language. It re-renders with
 * the copy, so it follows the language as the person picks.
 * @param props - the copy.
 * @returns the picture.
 */
export function StudioPreview({ t }: { readonly t: StepServices['t'] }): ReactNode {
  return (
    <div className={welcome.preview} role="img" aria-label={t('welcome.preview')}>
      <div className={welcome.side} aria-hidden="true">
        <span className={welcome.brand}>Delorun</span>
        <span className={welcome.newChat}>{t('welcome.preview.newChat')}</span>
        <span className={welcome.group}>{t('welcome.preview.today')}</span>
        <span className={welcome.chat} data-current="true">{t('look.preview.ask')}</span>
        <span className={welcome.chat}>{t('welcome.preview.chat.1')}</span>
        <span className={welcome.chat}>{t('welcome.preview.chat.2')}</span>
      </div>
      <div className={welcome.main} aria-hidden="true">
        <span className={welcome.ask}>{t('look.preview.ask')}</span>
        <span className={welcome.answer}>{t('look.preview.answer')}</span>
        <span className={`${welcome.ask} ${welcome.more}`}>{t('welcome.preview.ask.2')}</span>
        <span className={`${welcome.answer} ${welcome.more}`}>{t('welcome.preview.answer.2')}</span>
        <span className={`${welcome.ask} ${welcome.more}`}>{t('welcome.preview.ask.3')}</span>
        <span className={`${welcome.answer} ${welcome.more}`}>{t('welcome.preview.answer.3')}</span>
        <span className={welcome.box}>{t('look.preview.box')}</span>
      </div>
    </div>
  )
}

/**
 * @param props - the services, the guide, the preview notice when it is owed and the Tailscale address of the studio when device access is on.
 * @returns the step body.
 */
export function WelcomeStep({ services, notice, deviceAddress }: StepProps & { readonly notice: NoticeFace | undefined; readonly deviceAddress?: string | undefined }): ReactNode {
  const { t, language } = services
  const locale = useSyncExternalStore(useCallback(listener => language.subscribe(listener), [language]), () => language.getSnapshot())
  const [first, ...rest] = notice?.paragraphs() ?? []
  return (
    <div className={`${css.stack} ${welcome.welcome}`}>
      <p className={css.lead}>{t('welcome.lead')}</p>
      {deviceAddress !== undefined && <p className={css.hint}>{t('welcome.devices')} <code className={`${css.command} ${welcome.address}`}>{deviceAddress}</code></p>}
      <div className={welcome.tiles}>
        <ChipGroup label={t('welcome.language')} value={locale.active} onChange={(id) => { language.setLocale(id) }} variant="tiles" hideLabel
          options={locale.locales.filter(each => COVERED_LOCALES.includes(each.id) || each.id === locale.active).map(each => ({
            value: each.id, label: ownLine(each.id) ?? each.label, mark: <span className={welcome.glyph}>{each.label}</span>,
          }))} />
      </div>
      <StudioPreview t={t} />
      {first !== undefined && (
        <Notice title={notice?.title() ?? ''} moreLabel={t('readMore')}
          more={rest.length === 0 ? undefined : rest.map(paragraph => <p key={paragraph}>{paragraph}</p>)}>
          {first}
        </Notice>
      )}
    </div>
  )
}
