/** What the panel shows, derived from the source's items; one hook serves the card, the phone row and the sheet. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isActive, isDone, type DownloadItem, type DownloadsSource } from './source.ts'

/** How long "5 plugins added" stays, in milliseconds. */
export const SUMMARY_MS = 4000

/** What the panel does now. */
export type Phase = 'hidden' | 'working' | 'summary' | 'attention'

/** The derived view. */
export interface PanelModel {
  /** Whether to show, and which way. */
  readonly phase: Phase
  /** Items to list: queued, running, failed and, until the summary hides, finished ones. */
  readonly items: readonly DownloadItem[]
  /** The item being worked on counted from 1, and the batch size, for "Installing 2 of 5". */
  readonly done: number
  readonly total: number
  /** Items still queued or running. */
  readonly active: number
  /** Items that failed. */
  readonly failed: number
  /** Added in this batch. */
  readonly added: number
  /** 0–100 over the whole batch, for the one-line view. */
  readonly percent: number
  /** A sentence for a polite live region: set once on completion or a new failure, never per percent. */
  readonly announcement: { readonly kind: 'summary'; readonly count: number } | { readonly kind: 'failed'; readonly name: string } | undefined
}

/**
 * The fraction of one item that is done.
 * @param item - the item.
 * @returns 0 to 1.
 */
export function itemFraction(item: DownloadItem): number {
  switch (item.state) {
    case 'downloading': return item.totalBytes === undefined || item.totalBytes <= 0 ? 0 : Math.min(1, item.receivedBytes / item.totalBytes)
    case 'verifying': case 'installing': case 'ready': case 'needs-reload': return 1
    case 'queued': case 'waiting-for-unlock': case 'failed': case 'cancelled': return 0
  }
}

/**
 * Follow the source and derive the view.
 * @param source - the data seat.
 * @param summaryMs - how long the completion summary stays.
 * @returns the derived view.
 */
export function useDownloadsModel(source: DownloadsSource, summaryMs: number = SUMMARY_MS): PanelModel {
  const items = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot)
  const finished = useRef(new Set<string>())
  const [summaryOver, setSummaryOver] = useState(false)
  const [announced, setAnnounced] = useState<PanelModel['announcement']>(undefined)
  const knownFailures = useRef(new Set<string>())
  const acknowledged = useRef(new Set<string>())
  for (const key of acknowledged.current) if (!items.some(item => item.key === key && isDone(item))) acknowledged.current.delete(key)
  const visible = items.filter(item => item.state !== 'cancelled' && !acknowledged.current.has(item.key))
  const active = visible.filter(isActive)
  const failedItems = visible.filter(item => item.state === 'failed')
  for (const item of visible) if (isDone(item)) finished.current.add(item.key)
  const added = finished.current.size
  const phase: Phase = active.length > 0 ? 'working'
    : failedItems.length > 0 ? 'attention'
      : added > 0 && !summaryOver ? 'summary' : 'hidden'
  useEffect(() => {
    if (active.length > 0) setSummaryOver(false)
  }, [active.length])
  useEffect(() => {
    if (phase !== 'summary') return undefined
    const timer = setTimeout(() => { for (const key of finished.current) acknowledged.current.add(key); finished.current.clear(); setSummaryOver(true) }, summaryMs)
    return () => { clearTimeout(timer) }
  }, [phase, added, summaryMs])
  useEffect(() => {
    if (phase === 'summary') setAnnounced({ kind: 'summary', count: added })
  }, [phase, added])
  const failureKeys = failedItems.map(item => item.key).join('\n')
  useEffect(() => {
    const fresh = failedItems.find(item => !knownFailures.current.has(item.key))
    knownFailures.current = new Set(failedItems.map(item => item.key))
    if (fresh !== undefined) setAnnounced({ kind: 'failed', name: fresh.title ?? fresh.key })
  }, [failureKeys])
  const total = active.length + failedItems.length + added
  const done = Math.min(total, added + failedItems.length + 1)
  const sum = visible.filter(item => item.state !== 'failed').reduce((all, item) => all + itemFraction(item), 0)
  const percent = total === 0 ? 0 : Math.floor((sum / Math.max(1, active.length + added)) * 100)
  const listed = phase === 'hidden' ? [] : visible.filter(item => isActive(item) || item.state === 'failed' || isDone(item))
  return { phase, items: listed, done, total, active: active.length, failed: failedItems.length, added, percent, announcement: announced }
}
