/**
 * Browser: whether agents may use a web browser, as the shared Browser choice (`@delorun/browser-setup`). For the home
 * the choice is the Browser plugin pack, on until the person turns it off: the isolated browser is the choice until
 * then and adds the pack through the guide's installer, and No browser turns it off and records that. Under the choice the step says whether Browser is ready, read from the Host's requirement check, or
 * where adding the pack stands, and what the first chat that uses it asks.
 */
import { BROWSER_BUNDLE } from '@delorun/browser-setup'
import { BrowserChoices } from '@delorun/browser-setup/client'
import type { ReactNode } from 'react'
import { useBrowser } from '../browser/use-browser.ts'
import type { BundleView } from '../bundles.ts'
import type { StepServices } from '../types.ts'
import { Explain } from '../ui/Explain.tsx'
import { StateLine } from '../ui/StateLine.tsx'
import { DownloadBlock, useDownloadView } from './BundleCard.tsx'
import type { StepProps } from './shared.ts'
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
  const download = useDownloadView(BROWSER_BUNDLE)
  const progress = download === undefined ? null : <DownloadBlock label={t('step.browser')} download={download} />
  switch (state) {
    case 'checking': return <StateLine tone="loading">{t('bundle.checking')}</StateLine>
    // The add starts with the choice, so an available pack is about to be adding.
    case 'available': return null
    case 'installing': return <><StateLine tone="loading">{t('bundle.adding')}</StateLine>{progress}</>
    case 'slow': return <><StateLine tone="loading">{t('bundle.slow')}</StateLine>{progress}</>
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
 * The Browser step.
 * @param props - the services and the guide.
 * @returns the step body.
 */
export function BrowserStep({ services }: StepProps): ReactNode {
  const { t, browser } = services
  const { choice, view, readiness, on, result, working, retry, turnOn, turnOff } = useBrowser(services)
  const adding = view?.state === 'installing' || view?.state === 'slow'
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('browser.lead')}</p>
      <BrowserChoices t={t} choice={choice === 'on' ? 'isolated' : 'none'} onChoice={(next) => { void (next === 'isolated' ? turnOn() : turnOff()) }}
        disabled={adding || working} readiness={readiness}
        notAdded={<PackLine view={view} services={services} onRetry={retry} />}
        onRetry={() => { void browser.setup.refresh() }} onOpenSettings={browser.openSettings} />
      <div aria-live="polite">
        {result.kind === 'done' && result.outcome === 'restart' && <StateLine tone="info">{t('browser.turnOff.restart')}</StateLine>}
        {result.kind === 'failed' && <StateLine tone="error">{t(on ? 'browser.turnOff.failed' : 'browser.turnOn.failed')}</StateLine>}
      </div>
      <Explain heading={t('browser.expect')} cards={EXPECT.map(key => ({ key, title: t(`browser.expect.${key}.title`), text: t(`browser.expect.${key}.text`) }))} />
    </div>
  )
}
