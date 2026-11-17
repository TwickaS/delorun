/**
 * Browser: whether agents may use a web browser, as the shared Browser choice (`@delorun/browser-setup`). For the home
 * the choice is the Browser plugin pack: the isolated browser adds it through the guide's installer, and No browser
 * turns it off. Under the choice the step says whether Browser is ready, read from the Host's requirement check, or
 * where adding the pack stands, and what the first chat that uses it asks. While the preview flag
 * `onboarding.previewSteps` is on, the planned third choice shows, disabled.
 */
import { BROWSER_BUNDLE, browserAdded } from '@delorun/browser-setup'
import { BrowserChoices, type BrowserChoice } from '@delorun/browser-setup/client'
import { PreviewFlagsProvider, usePreviewFlag } from '@delorun/preview-flags/client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { PREVIEW_STEPS } from '../../preview-flags.ts'
import type { TurnOffOutcome } from '../browser-pack.ts'
import type { BundleView } from '../bundles.ts'
import type { StepServices } from '../types.ts'
import { Explain } from '../ui/Explain.tsx'
import { StateLine } from '../ui/StateLine.tsx'
import { useBundle, useRefresh, type StepProps } from './shared.ts'
import css from './steps.module.css'

/** The cards that say what to expect from Browser. */
const EXPECT = ['asks', 'own', 'off'] as const

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when BundleState widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled bundle state ${JSON.stringify(value)}`)
}

/**
 * Where adding the Browser pack stands, drawn while the isolated browser is chosen and the Host does not list the
 * pack yet.
 * @param props - the pack's view, the services and the retry.
 * @returns the state line, or nothing while there is nothing to say.
 */
function PackLine({ view, services, onRetry }: { readonly view: BundleView | undefined; readonly services: StepServices; readonly onRetry: () => void }): ReactNode {
  const { t } = services
  const state = view?.state ?? 'checking'
  switch (state) {
    case 'checking': return <StateLine tone="loading">{t('bundle.checking')}</StateLine>
    // The add starts with the choice, so an available pack is about to be adding.
    case 'available': return null
    case 'installing': return <StateLine tone="loading">{t('bundle.adding')}</StateLine>
    case 'slow': return <StateLine tone="loading">{t('bundle.slow')}</StateLine>
    case 'offline': return <StateLine tone="info">{t('bundle.offline')}</StateLine>
    case 'unavailable': return <StateLine tone="warning">{view?.packsReason === undefined ? t('bundle.unavailable') : t('bundle.unavailableWhy', { reason: view.packsReason })}</StateLine>
    case 'failed': return <StateLine tone="error" action={{ label: t('bundle.retry'), onClick: onRetry }}>{view?.reason === undefined ? t('bundle.failed') : t('bundle.failedWhy', { reason: view.reason })}</StateLine>
    case 'restart': return <StateLine tone="info">{t('bundle.restart')}</StateLine>
    case 'installed': return <StateLine tone="info">{t('browser.added')}</StateLine>
    /* v8 ignore next 2 -- closed-union default only defends a future widening of BundleState */
    default: return assertNever(state)
  }
}

/**
 * The step's content, under the provider its preview flag is read from.
 * @param props - the services and the guide.
 * @returns the content.
 */
function BrowserBody({ services }: StepProps): ReactNode {
  const { t, browser, bundles } = services
  const readiness = useSyncExternalStore(browser.setup.subscribe, browser.setup.getSnapshot)
  const view = useBundle(services, BROWSER_BUNDLE)
  useRefresh(services, [BROWSER_BUNDLE])
  // Read when the step opens, when the pack's state changes (it was just added or turned off), and when the window
  // regains focus, so a need the person met in a terminal clears without leaving the step.
  useEffect(() => {
    void browser.setup.refresh()
    const again = (): void => { void browser.setup.refresh() }
    window.addEventListener('focus', again)
    return () => { window.removeEventListener('focus', again) }
  }, [browser.setup, view?.state])
  const planned = usePreviewFlag(PREVIEW_STEPS.id)
  const adding = view?.state === 'installing' || view?.state === 'slow'
  const on = adding || view?.state === 'installed' || view?.state === 'restart' || browserAdded(readiness)
  // What the person chose in this step; until then the choice is whether the pack is on.
  const [wanted, setWanted] = useState<BrowserChoice | undefined>()
  const [turnOff, setTurnOff] = useState<TurnOffOutcome | 'running' | undefined>()
  const choice = wanted ?? (on ? 'isolated' : 'none')
  const add = (): void => { void bundles.install(BROWSER_BUNDLE) }
  const choose = (next: BrowserChoice): void => {
    setWanted(next)
    setTurnOff(undefined)
    if (next === 'isolated') {
      if (!on) add()
      return
    }
    if (!on) return
    setTurnOff('running')
    void browser.turnOff().then((outcome) => {
      setTurnOff(outcome)
      // A pack that stays on is still the choice in effect.
      if (outcome === 'failed') setWanted('isolated')
      bundles.refresh([BROWSER_BUNDLE])
    })
  }
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('browser.lead')}</p>
      <BrowserChoices t={t} choice={choice} onChoice={choose} disabled={adding || turnOff === 'running'} readiness={readiness} planned={planned}
        notAdded={<PackLine view={view} services={services} onRetry={add} />}
        onRetry={() => { void browser.setup.refresh() }} onOpenSettings={browser.openSettings} />
      <div aria-live="polite">
        {turnOff === 'restart' && <StateLine tone="info">{t('browser.turnOff.restart')}</StateLine>}
        {turnOff === 'failed' && <StateLine tone="error">{t('browser.turnOff.failed')}</StateLine>}
      </div>
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
