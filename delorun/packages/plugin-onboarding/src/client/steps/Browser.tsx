/**
 * Browser: whether the Browser plugin pack is ready, read from the Host's requirement check, with the pack's own Add
 * card, the action that meets an unmet need, and what the first chat that uses it asks. While the preview flag
 * `onboarding.previewSteps` is on, it also shows the planned choice of the person's own browser, marked Preview; that
 * choice is kept only while the step shows and is sent nowhere.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RequirementFix } from '@delorun/bundle-local/requirements-api'
import { PreviewChip, PreviewFlagsProvider, usePreviewFlag } from '@delorun/preview-flags/client'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { PREVIEW_STEPS } from '../../preview-flags.ts'
import { BROWSER_BUNDLE, type BrowserSetup } from '../browser-setup.ts'
import type { BundleState } from '../bundles.ts'
import type { StepServices } from '../types.ts'
import { CommandRow } from '../ui/CommandRow.tsx'
import { Explain } from '../ui/Explain.tsx'
import { StateLine } from '../ui/StateLine.tsx'
import { BundleCard } from './BundleCard.tsx'
import { readableName, useBundle, useRefresh, type StepProps } from './shared.ts'
import own from './browser.module.css'
import css from './steps.module.css'

/** The cards that say what to expect from Browser. */
const EXPECT = ['asks', 'own', 'off'] as const

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when BrowserSetup or RequirementFix widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled Browser setup ${JSON.stringify(value)}`)
}

/**
 * The action that meets Browser's unmet need: a command to copy, a Settings section, or a page that says how.
 * @param props - the fix and the services.
 * @returns the control.
 */
function Fix({ fix, services }: { readonly fix: RequirementFix; readonly services: StepServices }): ReactNode {
  const { t } = services
  switch (fix.kind) {
    case 'command':
      return (
        <div className={own.fix}>
          <span className={css.hint}>{t('browser.fix.command')}</span>
          <CommandRow command={fix.command} t={t} />
        </div>
      )
    case 'settings':
      return <Button variant="outline" size="sm" className={`${css.alignStart} ${css.target} ${css.inline}`} onClick={() => { services.browser.openSettings(fix.section) }}>{t('browser.fix.settings')}</Button>
    case 'docs':
      return <a className={own.link} href={fix.url} target="_blank" rel="noopener noreferrer">{t('browser.fix.docs')}</a>
    /* v8 ignore next 2 -- closed-union default only defends a future widening of RequirementFix */
    default:
      return assertNever(fix)
  }
}

/**
 * Whether Browser is ready, in one state line with the action that fixes it.
 * @param props - where Browser's setup stands, where its pack stands, and the services.
 * @returns the line, and the fix under it.
 */
function Readiness({ setup, pack, services }: { readonly setup: BrowserSetup; readonly pack: BundleState | undefined; readonly services: StepServices }): ReactNode {
  const { t } = services
  switch (setup.kind) {
    case 'checking':
      return <StateLine tone="loading">{t('browser.checking')}</StateLine>
    case 'ready':
      return <StateLine tone="success">{t('browser.ready')}</StateLine>
    case 'needs-setup':
      return (
        <>
          <StateLine tone="warning">{t('browser.needsSetup', { reason: setup.reason })}</StateLine>
          <Fix fix={setup.fix} services={services} />
        </>
      )
    case 'problem':
      return <StateLine tone="error">{t('browser.problem', { message: setup.message })}</StateLine>
    case 'failed':
      return <StateLine tone="warning" action={{ label: t('bundle.retry'), onClick: () => { void services.browser.setup.refresh() } }}>{t('browser.unread')}</StateLine>
    case 'not-added':
      // The pack's own card says where an add stands, and why a pack cannot be added here; this line only says what
      // the step shows once the pack is in.
      if (pack === 'installed') return <StateLine tone="info">{t('browser.added')}</StateLine>
      return pack === 'available' || pack === 'installing' || pack === 'slow' ? <p className={css.hint}>{t('browser.notAdded')}</p> : null
    /* v8 ignore next 2 -- closed-union default only defends a future widening of BrowserSetup */
    default:
      return assertNever(setup)
  }
}

/** The browsers the planned choice offers. */
type Which = 'own' | 'mine'

/**
 * The planned choice of browser, shown only while the preview flag is on. The choice is this component's own state: it
 * is not saved, not sent to the Host and read by nothing else.
 * @param props - this plugin's copy.
 * @returns the choice.
 */
function WhichBrowser({ t }: { readonly t: StepServices['t'] }): ReactNode {
  const [which, setWhich] = useState<Which>('own')
  const id = useId()
  return (
    <section className={own.which} aria-labelledby={`${id}-label`} data-preview="onboarding.previewSteps">
      <h3 id={`${id}-label`} className={own.heading}>{t('browser.which')}</h3>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className={own.options}>
        {(['own', 'mine'] as const).map(option => (
          <div key={option} className={own.option} data-selected={which === option ? '' : undefined}>
            <input type="radio" className={own.radio} name={id} value={option} checked={which === option}
              aria-labelledby={`${id}-${option}-title`} aria-describedby={`${id}-${option}-text`} onChange={() => { setWhich(option) }} />
            <span className={own.optionTitle}>
              <span id={`${id}-${option}-title`}>{t(`browser.which.${option}.title`)}</span>
              {option === 'mine' && <span className={own.chip}><PreviewChip t={t} tooltip={t('browser.which.mine.preview')} /></span>}
            </span>
            <span id={`${id}-${option}-text`} className={own.optionText}>{t(`browser.which.${option}.text`)}</span>
          </div>
        ))}
      </div>
      <p className={css.hint}>{t('browser.which.note')}</p>
    </section>
  )
}

/**
 * The step's content, under the provider its preview flag is read from.
 * @param props - the services and the guide.
 * @returns the content.
 */
function BrowserBody({ services }: StepProps): ReactNode {
  const { t, browser, resolveText } = services
  const setup = useSyncExternalStore(browser.setup.subscribe, browser.setup.getSnapshot)
  const view = useBundle(services, BROWSER_BUNDLE)
  useRefresh(services, [BROWSER_BUNDLE])
  // Read when the step opens, when the pack's state changes (it was just added), and when the window regains focus,
  // so a need the person met in a terminal clears without leaving the step.
  useEffect(() => {
    void browser.setup.refresh()
    const again = (): void => { void browser.setup.refresh() }
    window.addEventListener('focus', again)
    return () => { window.removeEventListener('focus', again) }
  }, [browser.setup, view?.state])
  const previews = usePreviewFlag(PREVIEW_STEPS.id)
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('browser.lead')}</p>
      <ul className={css.cards}>
        <BundleCard name={BROWSER_BUNDLE} services={services}
          title={view?.title === undefined ? readableName(BROWSER_BUNDLE) : resolveText(view.title)}
          description={view?.description === undefined ? t('browser.pack.description') : resolveText(view.description)} />
      </ul>
      <div className={own.readiness} aria-live="polite">
        <Readiness setup={setup} pack={view?.state} services={services} />
      </div>
      {previews && <WhichBrowser t={t} />}
      <Explain heading={t('browser.expect')} cards={EXPECT.map(key => ({ key, title: t(`browser.expect.${key}.title`), text: t(`browser.expect.${key}.text`) }))} />
    </div>
  )
}

/**
 * The Browser step.
 * @param props - the services and the guide.
 * @returns the step body.
 */
export function BrowserStep(props: StepProps): ReactNode {
  return (
    <PreviewFlagsProvider store={props.services.previewFlags}>
      <BrowserBody {...props} />
    </PreviewFlagsProvider>
  )
}
