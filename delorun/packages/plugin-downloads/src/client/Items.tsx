/** The list both presentations share: one row per plugin with its icon, name, progress and actions. */
import { IconCheckOutlineRegular, IconCloseOutlineRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatSize } from '@delorun/plugin-packs/transfer'
import type { ReactNode } from 'react'
import css from './Items.module.css'
import { itemFraction } from './model.ts'
import { nameOf } from './names.ts'
import { rateText, useDownloadRate, type DownloadRate } from './rate.ts'
import { providedTranslate, type DownloadItem, type DownloadsSource } from './source.ts'
import { fallbackTranslate, type Translate } from './locales.ts'

/** Props of the list. */
export interface ItemListProps {
  /** The rows. */
  readonly items: readonly DownloadItem[]
  /** The actions the buttons call. */
  readonly source: Pick<DownloadsSource, 'cancel' | 'retry' | 'remove'>
  /** The copy. */
  readonly t: Translate
  /** `quiet` is the phone setup guide's muted look: no accent, no motion beyond the progress. */
  readonly tone: 'card' | 'quiet'
  /** The list's accessible name. */
  readonly label: string
}

/**
 * Whether a download runs without a size, so its bar moves without a measure.
 * @param item - the item.
 * @returns true while it downloads and the queue holds no size for it.
 */
export function unmeasured(item: DownloadItem): boolean {
  return item.state === 'downloading' && (item.totalBytes === undefined || item.totalBytes <= 0)
}

/**
 * The status text of a download: its percentage, or the bytes received while the queue holds no size, then its speed
 * and time left once they are known.
 * @param item - a downloading item.
 * @param t - the copy.
 * @param rate - its speed and time left.
 * @returns the text.
 */
function downloadingText(item: DownloadItem, t: Translate, rate: DownloadRate): string {
  const speed = rateText(rate, t)
  if (item.totalBytes === undefined || item.totalBytes <= 0) {
    if (item.receivedBytes <= 0) return t('state.downloading')
    return speed === '' ? formatSize(item.receivedBytes) : t('state.receivedRate', { size: formatSize(item.receivedBytes), rate: speed })
  }
  const percent = Math.floor(itemFraction(item) * 100)
  return speed === '' ? `${String(percent)}%` : t('state.downloadingRate', { percent, rate: speed })
}

/**
 * The status text under a name.
 * @param item - the item.
 * @param t - the copy.
 * @param rate - a download's speed and time left, when known.
 * @returns the text.
 */
export function statusText(item: DownloadItem, t: Translate, rate: DownloadRate = {}): string {
  switch (item.state) {
    case 'downloading': return downloadingText(item, t, rate)
    case 'queued': return item.position === undefined ? t('state.queuedNoPosition') : item.position <= 1 ? t('state.queuedNext') : t('state.queued', { ahead: item.position - 1 })
    case 'waiting-for-unlock': return t('state.waitingForUnlock')
    case 'verifying': return t('state.verifying')
    case 'installing': return t('state.installing')
    case 'ready': return t('state.ready')
    case 'needs-reload': return t('state.needsReload')
    case 'failed': return item.failure?.message ?? t('state.failed')
    case 'cancelled': return ''
  }
}

/**
 * One download's status in the plugin's bound copy, with its speed and time left while it downloads, for a surface
 * outside the panel such as the setup guide's cards: the same words as the panel's row.
 * @param item - the download, or undefined when the queue does not list it.
 * @returns the text, or an empty string for an item the queue does not list.
 */
export function useDownloadStatusText(item: DownloadItem | undefined): string {
  const rate = useDownloadRate(item)
  return item === undefined ? '' : statusText(item, providedTranslate() ?? fallbackTranslate, rate)
}

function Icon({ item, t }: { readonly item: DownloadItem, readonly t: Translate }): ReactNode {
  const name = nameOf(item, t)
  return item.iconUrl === undefined
    ? <span className={css.icon} aria-hidden="true">{[...name.replace(/^@[^/]*\//, '').replace(/^(plugin-)/, '')][0]?.toUpperCase() ?? ''}</span>
    : <img className={css.icon} src={item.iconUrl} alt="" />
}

function Row({ item, source, t, tone }: Omit<ItemListProps, 'items' | 'label'> & { readonly item: DownloadItem }): ReactNode {
  const name = nameOf(item, t)
  const running = item.state === 'downloading' || item.state === 'verifying' || item.state === 'installing'
  const done = item.state === 'ready' || item.state === 'needs-reload'
  const failed = item.state === 'failed'
  const text = statusText(item, t, useDownloadRate(item))
  // The progress bar's own text leaves out the speed, which changes every second.
  const valueText = statusText(item, t)
  return (
    <li className={css.row} data-state={item.state} data-tone={tone}>
      <Icon item={item} t={t} />
      <div className={css.main}>
        <span className={css.name}>{name}</span>
        {failed || done
          ? <span className={css.status} data-failed={failed || undefined}>{text}</span>
          : (
            <>
              <span className={css.track}>
                <span role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={unmeasured(item) ? undefined : Math.floor(itemFraction(item) * 100)} aria-valuetext={valueText}
                  className={`${css.fill} ${running && tone === 'card' ? css.accent : ''}`} data-unmeasured={unmeasured(item) || undefined} style={unmeasured(item) ? undefined : { width: `${String(itemFraction(item) * 100)}%` }} />
              </span>
              <span className={css.status}>{text}</span>
            </>
          )}
      </div>
      <span className={css.actions}>
        {done && <span className={css.tick} aria-hidden="true"><IconCheckOutlineRegular /></span>}
        {failed && <span className={css.marker} aria-hidden="true"><IconWarningOutlineRegular /></span>}
        {(running || item.state === 'queued' || item.state === 'waiting-for-unlock') && item.local === undefined && (
          <button type="button" className={css.action} aria-label={t('cancelItem', { name })} title={t('cancel')} onClick={() => { source.cancel(item.key) }}>
            <IconCloseOutlineRegular />
          </button>
        )}
        {failed && (
          <>
            {item.local?.retry !== false && <button type="button" className={css.text} aria-label={t('retryItem', { name })} onClick={() => { source.retry(item.key) }}>{t('retry')}</button>}
            <button type="button" className={css.text} aria-label={t('removeItem', { name })} onClick={() => { source.remove(item.key) }}>{t('remove')}</button>
          </>
        )}
      </span>
    </li>
  )
}

/**
 * The rows.
 * @param props - the items, the actions and the copy.
 * @returns the list.
 */
export function ItemList({ items, source, t, tone, label }: ItemListProps): ReactNode {
  return (
    <ul className={css.list} aria-label={label} data-tone={tone}>
      {items.map(item => <Row key={item.key} item={item} source={source} t={t} tone={tone} />)}
    </ul>
  )
}
