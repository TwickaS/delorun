/**
 * Welcome: the language, and the preview notice while it is owed, with its longer text behind "Read more".
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { NoticeFace } from '../types.ts'
import { ChipGroup } from '@delorun/brand'
import { Notice } from '../ui/Notice.tsx'
import type { StepProps } from './shared.ts'
import css from './steps.module.css'

/**
 * @param props - the services, the guide and the preview notice when it is owed.
 * @returns the step body.
 */
export function WelcomeStep({ services, notice }: StepProps & { readonly notice: NoticeFace | undefined }): ReactNode {
  const { t, language } = services
  const locale = useSyncExternalStore(useCallback(listener => language.subscribe(listener), [language]), () => language.getSnapshot())
  const [first, ...rest] = notice?.paragraphs() ?? []
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('welcome.lead')}</p>
      <div className={css.chipGrid}>
        <ChipGroup label={t('welcome.language')} value={locale.active} onChange={(id) => { language.setLocale(id) }}
          options={locale.locales.map(each => ({ value: each.id, label: each.label }))} />
      </div>
      {first !== undefined && (
        <Notice title={notice?.title() ?? ''} moreLabel={t('readMore')}
          more={rest.length === 0 ? undefined : rest.map(paragraph => <p key={paragraph}>{paragraph}</p>)}>
          {first}
        </Notice>
      )}
    </div>
  )
}
