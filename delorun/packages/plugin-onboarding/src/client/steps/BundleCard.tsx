/**
 * The card for a package or a bundled row the person can add: its state decides the action area (Add, or Added with a
 * check) and the state line under the card (checking, adding, restart, unavailable or failed with what to do next).
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { BundleState } from '../bundles.ts'
import type { StepServices } from '../types.ts'
import { Card } from '../ui/Card.tsx'
import { StateLine } from '../ui/StateLine.tsx'
import { readableName, useBundle } from './shared.ts'
import css from './steps.module.css'

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when BundleState widens without this switch */
function assertNever(value: never): never {
  throw new Error(`unhandled bundle state ${String(value)}`)
}

/** The props of an addable card. */
interface AddableProps {
  /** The services. */
  readonly services: StepServices
  /** Where the package stands. */
  readonly state: BundleState
  /** Why the plugin manager reports `failed`, in its own words. */
  readonly reason?: string | undefined
  /** Why this Host has no plugin packs, for an unavailable package that is not a platform limit. */
  readonly packsReason?: string | undefined
  /** The title. */
  readonly title: string
  /** The icon's address, if the package has artwork. */
  readonly icon?: string | undefined
  /** The description. */
  readonly description?: string | undefined
  /** Add it; the agents' card opens its confirmation here. */
  readonly onAdd: () => void
  /** Extra state lines and content under the card. */
  readonly children?: ReactNode
}

/**
 * One addable card.
 * @param props - the package's state, text and Add handler.
 * @returns the card.
 */
export function AddableCard({ services, state, reason, packsReason, title, icon, description, onAdd, children }: AddableProps): ReactNode {
  const { t } = services
  let action: ReactNode
  let line: ReactNode
  switch (state) {
    case 'checking':
      line = <StateLine tone="loading">{t('bundle.checking')}</StateLine>
      break
    case 'available':
      action = <Button variant="outline" size="sm" className={css.inline} aria-label={t('bundle.addNamed', { name: title })} onClick={onAdd}>{t('bundle.add')}</Button>
      break
    case 'installing':
      line = <StateLine tone="loading">{t('bundle.adding')}</StateLine>
      break
    case 'offline':
      line = <StateLine tone="info">{t('bundle.offline')}</StateLine>
      break
    case 'slow':
      line = <StateLine tone="loading">{t('bundle.slow')}</StateLine>
      break
    case 'installed':
      action = <span className={css.added}><span aria-hidden="true">✓</span> {t('bundle.added')}</span>
      break
    case 'restart':
      action = <span className={css.added}><span aria-hidden="true">✓</span> {t('bundle.added')}</span>
      line = <StateLine tone="info">{t('bundle.restart')}</StateLine>
      break
    case 'unavailable':
      line = <StateLine tone="warning">{packsReason === undefined ? t('bundle.unavailable') : t('bundle.unavailableWhy', { reason: packsReason })}</StateLine>
      break
    case 'failed':
      line = <StateLine tone="error" action={{ label: t('bundle.retry'), onClick: onAdd }}>{reason === undefined ? t('bundle.failed') : t('bundle.failedWhy', { reason })}</StateLine>
      break
    /* v8 ignore next 2 -- closed-union default only defends future widening of BundleState */
    default:
      return assertNever(state)
  }
  return (
    <li>
      <Card title={title} icon={icon} description={description} labels={{ more: t('more'), less: t('less') }} action={action}>
        {children}
        {line}
      </Card>
    </li>
  )
}

/**
 * A placeholder for a card whose title has not arrived, so a package id never shows.
 * @returns the placeholder row, hidden from assistive technology.
 */
export function SkeletonCard(): ReactNode {
  return (
    <li className={css.skeleton} aria-hidden="true">
      <span className={css.skeletonIcon} />
      <span className={css.skeletonLines}><span /><span /></span>
    </li>
  )
}

/**
 * A card for a package.
 * @param props - the package, its text and Add handler.
 * @returns the card.
 */
export function BundleCard({ name, title, description, services, onAdd, children }: {
  readonly name: string
  /** The title; undefined while it is unknown, which shows a placeholder. */
  readonly title: string | undefined
  readonly description: string | undefined
  readonly services: StepServices
  readonly onAdd?: () => void
  readonly children?: ReactNode
}): ReactNode {
  const view = useBundle(services, name)
  if (title === undefined) return <SkeletonCard />
  return (
    <AddableCard services={services} state={view?.state ?? 'checking'} reason={view?.reason} packsReason={view?.packsReason} title={title ?? ''} description={description}
      onAdd={onAdd ?? (() => { void services.bundles.install(name) })}>
      {children}
    </AddableCard>
  )
}

/**
 * A card for a bundled row: its title, description and icon come from its package, and nothing is turned on unless the
 * person presses Add.
 * @param props - the row and the services.
 * @returns the card.
 */
export function RowCard({ id, services }: { readonly id: string; readonly services: StepServices }): ReactNode {
  const { bundles, resolveText } = services
  const view = useSyncExternalStore(useCallback(listener => bundles.rows.subscribe(listener), [bundles]), () => bundles.rows.getSnapshot()[id])
  if (view?.title === undefined && (view === undefined || view.state === 'checking')) return <SkeletonCard />
  return (
    <AddableCard services={services} state={view?.state ?? 'checking'} title={view?.title === undefined ? readableName(id) : resolveText(view.title)}
      icon={view?.icon} description={view?.description === undefined ? undefined : resolveText(view.description)}
      onAdd={() => { void bundles.enableRow(id) }} />
  )
}
