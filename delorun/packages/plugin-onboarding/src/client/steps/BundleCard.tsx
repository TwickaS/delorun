/**
 * The card for a package or a bundled row the person can add: its state decides the action area (Add, or Added with a
 * check) and the state line under the card (checking, adding, restart, unavailable or failed with what to do next).
 * Recommended plugins draws it as the plugin market's entry row (`look="entry"`); Agents keeps the guide's own card.
 */
import { Button, PluginEntryCard, PluginEntryPlaceholder } from '@deepseek-ai/dsh-client-ui-primitives'
import { currentDownloadsSource, type DownloadItem, Figures, useDownloadStatusText } from '@delorun/plugin-downloads/row'
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { BundleState } from '../bundles.ts'
import type { StepServices } from '../types.ts'
import { Card, Monogram } from '../ui/Card.tsx'
import { StateLine } from '../ui/StateLine.tsx'
import { Summary } from '../ui/Summary.tsx'
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

/**
 * The Add control: a secondary button with a plus, as wide as the Adding and Added states beside it.
 * @param props - the visible label, the full accessible name and the handler.
 * @returns the button.
 */
function AddButton({ label, name, onAdd, plain = false }: { readonly label: string; readonly name: string; readonly onAdd: () => void; readonly plain?: boolean }): ReactNode {
  // The entry row's Add matches the market's Install: the words alone, as wide as they are.
  if (plain) return <Button variant="outline" size="sm" className={css.inline} aria-label={name} onClick={onAdd}>{label}</Button>
  return (
    <Button variant="outline" size="sm" className={`${css.inline} ${css.slotButton}`} aria-label={name} onClick={onAdd}>
      <svg className={css.plus} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /></svg>
      {label}
    </Button>
  )
}

/**
 * The Adding state of a row's action slot: the words alone, since the download's progress has the card's width under
 * it.
 * @param props - the label.
 * @returns the state.
 */
function Adding({ label }: { readonly label: string }): ReactNode {
  return <span className={css.adding} role="status">{label}</span>
}

/** Where a download stands, as the card draws it. */
export interface DownloadView {
  /** How far it has come, from 0 to 1; undefined while the queue holds no size for it. */
  readonly progress: number | undefined
  /** Whether it downloads without a size, so its bar moves without a measure. */
  readonly unmeasured?: boolean | undefined
  /** Its status in the downloads panel's words, with the speed and time left once known; empty before the first read. */
  readonly status: string
}

/**
 * The install queue's item for a package.
 * @param name - the package name.
 * @returns the item, or undefined while the queue does not list it.
 */
function useQueueItem(name: string): DownloadItem | undefined {
  const source = currentDownloadsSource()
  const items = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot)
  return items.find(each => each.key === name)
}

/**
 * Where the install queue says a package's download stands.
 * @param name - the package name.
 * @returns the view, or undefined while the queue does not list the package.
 */
export function useDownloadView(name: string): DownloadView | undefined {
  const item = useQueueItem(name)
  const status = useDownloadStatusText(item)
  if (item === undefined) return undefined
  const total = item.totalBytes ?? 0
  const progress = item.state === 'downloading' ? (total > 0 ? Math.min(1, item.receivedBytes / total) : undefined) : item.state === 'verifying' || item.state === 'installing' ? 1 : undefined
  return { progress, status, unmeasured: item.state === 'downloading' && total <= 0 }
}

/**
 * A download under a card, full width like a state line: a bar and one quiet line under it with the downloads panel's
 * status: waiting and its place, the percentage with the speed and time left, then checking and installing. The track
 * shows before the first bytes and the line keeps its height, so nothing moves as the download goes; the line is not a
 * live region, since it changes every second.
 * @param props - the name the bar is read by and the download.
 * @returns the block.
 */
export function DownloadBlock({ label, download }: { readonly label: string; readonly download: DownloadView }): ReactNode {
  const { progress, status, unmeasured = false } = download
  const percent = progress === undefined ? undefined : Math.round(progress * 100)
  return (
    <div className={css.download}>
      {unmeasured
        ? <span className={css.bar} role="progressbar" aria-label={label} aria-valuetext={status}><span data-unmeasured="" /></span>
        : percent === undefined
        ? <span className={css.bar} aria-hidden="true" />
        : <span className={css.bar} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${String(percent)}%`}><span style={{ width: `${String(percent)}%` }} /></span>}
      <p className={css.rate} data-empty={status === '' || undefined}>{status === '' ? '\u00a0' : <Figures text={status} />}</p>
    </div>
  )
}

/** The side of the guide's letter tile in a market entry's icon frame, the size the market gives its artwork. */
const ENTRY_TILE = 36

/** How an addable card is drawn: the guide's own card, or the plugin market's entry row. */
export type AddableLook = 'card' | 'entry'

/** The props of an addable card. */
interface AddableProps {
  /** How it is drawn; `card` when absent. */
  readonly look?: AddableLook | undefined
  /** For the entry row: the quiet line under the description, such as the connections the plugin fits. */
  readonly meta?: ReactNode
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
  /** Where the download stands while the install queue lists the package; drawn while the package is being added. */
  readonly download?: DownloadView | undefined
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
export function AddableCard({ look = 'card', meta, services, state, reason, packsReason, title, icon, description, download, onAdd, children }: AddableProps): ReactNode {
  const { t } = services
  let action: ReactNode
  let progress: ReactNode
  let line: ReactNode
  switch (state) {
    case 'checking':
      line = <StateLine tone="loading">{t('bundle.checking')}</StateLine>
      break
    case 'available':
      action = <AddButton label={t('bundle.add')} name={t('bundle.addNamed', { name: title })} onAdd={onAdd} plain={look === 'entry'} />
      break
    case 'installing':
      action = <Adding label={t('bundle.adding')} />
      progress = download === undefined ? undefined : <DownloadBlock label={title} download={download} />
      break
    case 'offline':
      line = <StateLine tone="info">{t('bundle.offline')}</StateLine>
      break
    case 'slow':
      action = <Adding label={t('bundle.adding')} />
      progress = download === undefined ? undefined : <DownloadBlock label={title} download={download} />
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
  if (look === 'entry') {
    return (
      <PluginEntryCard title={title} heading={3} icon={icon} iconFallback={<Monogram name={title} size={ENTRY_TILE} />} clamp={false} meta={meta} action={action}
        description={description === undefined ? undefined : <Summary text={description} labels={{ more: t('more'), less: t('less') }} inherit />}>
        {children}
        {progress}
        {line}
      </PluginEntryCard>
    )
  }
  return (
    <li>
      <Card title={title} icon={icon} description={description} labels={{ more: t('more'), less: t('less') }} action={action === undefined ? undefined : <div className={css.slot}>{action}</div>}>
        {children}
        {progress}
        {line}
      </Card>
    </li>
  )
}

/**
 * A placeholder for a card whose title has not arrived, so a package id never shows.
 * @returns the placeholder row, hidden from assistive technology.
 */
export function SkeletonCard({ look = 'card' }: { readonly look?: AddableLook | undefined }): ReactNode {
  if (look === 'entry') return <PluginEntryPlaceholder />
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
export function BundleCard({ look, meta, name, title, description, services, onAdd, children }: {
  /** How it is drawn; `card` when absent. */
  readonly look?: AddableLook | undefined
  /** For the entry row: the quiet line under the description. */
  readonly meta?: ReactNode
  readonly name: string
  /** The title; undefined while it is unknown, which shows a placeholder. */
  readonly title: string | undefined
  readonly description: string | undefined
  readonly services: StepServices
  readonly onAdd?: () => void
  readonly children?: ReactNode
}): ReactNode {
  const view = useBundle(services, name)
  const download = useDownloadView(name)
  if (title === undefined) return <SkeletonCard look={look} />
  return (
    <AddableCard look={look} meta={meta} services={services} state={view?.state ?? 'checking'} reason={view?.reason} packsReason={view?.packsReason} title={title ?? ''} description={description} download={download}
      onAdd={onAdd ?? (() => { void services.bundles.install(name) })}>
      {children}
    </AddableCard>
  )
}

/**
 * A card for a bundled row: its title, description and icon come from its package, and nothing is turned on unless the
 * person presses Add. Only Recommended plugins offers rows, so it is drawn as the market's entry row.
 * @param props - the row and the services.
 * @returns the card.
 */
export function RowCard({ id, services }: { readonly id: string; readonly services: StepServices }): ReactNode {
  const { bundles, resolveText } = services
  const view = useSyncExternalStore(useCallback(listener => bundles.rows.subscribe(listener), [bundles]), () => bundles.rows.getSnapshot()[id])
  if (view?.title === undefined && (view === undefined || view.state === 'checking')) return <SkeletonCard look="entry" />
  return (
    <AddableCard look="entry" services={services} state={view?.state ?? 'checking'} title={view?.title === undefined ? readableName(id) : resolveText(view.title)}
      icon={view?.icon} description={view?.description === undefined ? undefined : resolveText(view.description)}
      onAdd={() => { void bundles.enableRow(id) }} />
  )
}
