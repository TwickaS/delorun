/** The Trash section in Settings: what was deleted, with Restore and Delete forever per item and Empty trash. */
import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal, relativeTime, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TrashEntry, TrashListing } from '../wire.ts'
import type { TrashState } from './controller.ts'
import css from './TrashSection.module.css'

/** The controller's reads and calls the section uses. */
export interface TrashSectionInjected {
  readonly hooks: { readonly trash: HostObservable<TrashState> }
  /**
   * Read the listing again without showing the loading state.
   * @returns after the state is current.
   */
  readonly reload: () => Promise<void>
  /**
   * Show the loading state and read the listing.
   * @returns after the state is current.
   */
  readonly retry: () => Promise<void>
  /**
   * Return an item to where it was deleted from.
   * @param itemId - the item.
   * @returns after the outcome is reported.
   */
  readonly restore: (itemId: string) => Promise<void>
  /**
   * Delete an item forever.
   * @param itemId - the item.
   * @param clearLogs - whether to clear the operational logs now.
   * @returns after the outcome is reported.
   */
  readonly purge: (itemId: string, clearLogs: boolean) => Promise<void>
  /**
   * Delete every item forever.
   * @param clearLogs - whether to clear the operational logs now.
   * @returns after the outcome is reported.
   */
  readonly empty: (clearLogs: boolean) => Promise<void>
}

/** Props the renderer binds for the section. */
export type TrashSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloTrash'> & InjectFace<TrashSectionInjected>

/** Milliseconds in a day. */
const DAY_MS = 86_400_000

/** Skeleton rows the first load lays out. */
const SKELETON_ROWS = [0, 1, 2] as const

/** The listing the section shows until the first one arrives. */
const NOT_LOADED: TrashListing = { items: [], retentionDays: 0, residueDays: 0 }

/** What the confirmation dialog asks about: one item, or the whole trash. */
type Asking = { readonly kind: 'item'; readonly entry: TrashEntry } | { readonly kind: 'all' }

/**
 * The key of the singular or the plural copy for a count.
 * @param base - the key without its `.one` or `.other` suffix.
 * @param count - the count the copy states.
 * @returns the key to translate.
 */
function pluralKey<B extends string>(base: B, count: number) {
  return `${base}.${count === 1 ? 'one' : 'other'}` as const
}

/**
 * Render the section. Delete forever and Empty trash ask first, in a dialog that states what is deleted, what may
 * remain in the operational logs, and offers to clear them now.
 * @param props - the dictionary, the trash state and the controller's calls.
 * @returns the section.
 */
export function TrashSection(props: TrashSectionProps) {
  const { t, reload, retry, restore, purge, empty } = props
  const state = props.useTrash(value => value)
  const [asking, setAsking] = useState<Asking | undefined>()
  const [clearLogs, setClearLogs] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void reload() }, [reload])
  const run = (action: () => Promise<void>): void => {
    setBusy(true)
    void action().finally(() => { setBusy(false) })
  }
  const ask = (next: Asking): void => {
    setClearLogs(false)
    setAsking(next)
  }
  const now = Date.now()
  const listing = state.status === 'ready' ? state.listing : NOT_LOADED
  const { items } = listing
  const rows = items.map((entry) => {
    const since = relativeTime(entry.deletedAt, now)
    const daysLeft = Math.ceil((entry.expiresAt - now) / DAY_MS)
    return <li key={entry.id} className={css.row} data-item-kind={entry.kind}>
      <div className={css.main}>
        <div className={css.name}>{entry.label}</div>
        <div className={css.meta}>
          <span>{entry.kind === 'chat' ? t('kind.chat') : t(pluralKey('kind.workspace', entry.sessionIds.length), { n: entry.sessionIds.length })}</span>
          <span>{t(`deleted.${since.unit}`, { n: since.n })}</span>
          <span>{daysLeft <= 0 ? t('expires.due') : t(pluralKey('expires', daysLeft), { n: daysLeft })}</span>
        </div>
      </div>
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { run(() => restore(entry.id)) }}>{t('restore')}</Button>
        <Button variant="outline" size="sm" className={css.danger} disabled={busy} onClick={() => { ask({ kind: 'item', entry }) }}>{t('purge')}</Button>
      </div>
    </li>
  })
  const confirm = (target: Asking): void => {
    const logs = clearLogs
    setAsking(undefined)
    if (target.kind === 'item') run(() => purge(target.entry.id, logs))
    else run(() => empty(logs))
  }
  return <div className={css.section} aria-busy={state.status === 'loading'}>
    <div className={css.header}>
      <h2 className={css.heading}>{t('title')}</h2>
      <Button variant="outline" size="sm" className={css.emptyAll} disabled={busy || items.length === 0} onClick={() => { ask({ kind: 'all' }) }}>{t('emptyAll')}</Button>
    </div>
    {state.status === 'loading'
      ? <div className={css.rows} role="status">
        <span className={css.visuallyHidden}>{t('loading')}</span>
        {SKELETON_ROWS.map(slot => <div key={slot} className={css.skeletonRow} aria-hidden="true">
          <span className={css.skeletonBar} />
          <span className={css.skeletonBar} />
        </div>)}
      </div>
      : null}
    {state.status === 'error'
      ? <div className={css.failure}>
        <p className={css.failureText} role="alert"><StateDot state="error" />{t('list.failed')}</p>
        <Button variant="outline" size="sm" onClick={() => { run(retry) }}>{t('list.retry')}</Button>
      </div>
      : null}
    {state.status === 'ready' && items.length === 0
      ? <p className={css.status}>{t(pluralKey('empty', listing.retentionDays), { days: listing.retentionDays })}</p>
      : null}
    {rows.length === 0 ? null : <ul className={css.rows}>{rows}</ul>}
    {asking === undefined ? null : <Modal open onClose={() => { setAsking(undefined) }}
      title={t(asking.kind === 'item' ? 'purge.title' : 'emptyAll.title')} closeLabel={t('confirm.close')}
      footer={<>
        <Button variant="outline" data-modal-autofocus onClick={() => { setAsking(undefined) }}>{t('confirm.cancel')}</Button>
        <Button variant="primary" onClick={() => { confirm(asking) }}>{t(asking.kind === 'item' ? 'purge' : 'emptyAll')}</Button>
      </>}>
      <p className={css.confirmText}>{asking.kind === 'item' ? t('purge.body', { name: asking.entry.label }) : t('emptyAll.body')}</p>
      <p className={css.confirmText}>{t(pluralKey('residue', listing.residueDays), { days: listing.residueDays })}</p>
      <Checkbox checked={clearLogs} onChange={setClearLogs} label={t('clearLogs')} />
    </Modal>}
  </div>
}
