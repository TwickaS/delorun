/**
 * A download's speed and time left, measured in the page from the received bytes the install queue reports, with the
 * same window and formats as the terminal's install display (`@delorun/install/transfer`).
 */
import { formatRemaining, formatSpeed, STALL_SHOWN_MS, type TransferRate } from '@delorun/plugin-packs/transfer'
import { useEffect, useState } from 'react'
import type { Translate } from './locales.ts'
import { acquireMeter, releaseMeter, type DownloadItem } from './source.ts'

/** How often a running download's count is read again, so the speed follows a download that slows or stops. */
export const RATE_READ_MS = 1000

/** A download's speed and time left; each is absent while it is not known. */
export interface DownloadRate {
  /** Bytes per second over the recent window. */
  readonly speed?: number
  /** Seconds left at that speed; only with a known size. */
  readonly secondsLeft?: number
}

const NO_RATE: DownloadRate = {}

/**
 * What a meter says now: nothing while the download stands still, else its speed and, with a size, the time left.
 * @param meter - the meter.
 * @param total - the download's size, when known.
 * @param now - the clock now.
 * @returns the rate.
 */
function rateOf(meter: TransferRate, total: number | undefined, now: number): DownloadRate {
  if (meter.stalledFor(now) >= STALL_SHOWN_MS) return NO_RATE
  const speed = meter.speed()
  if (speed === undefined) return NO_RATE
  const secondsLeft = meter.secondsLeft(total)
  return secondsLeft === undefined ? { speed } : { speed, secondsLeft }
}

/**
 * Follow one download's speed and time left while it downloads. The count is read when it changes and again on each
 * whole {@link RATE_READ_MS} of the clock, so a stall clears the speed instead of leaving the last one standing. Every surface showing the
 * same download reads one shared meter (`acquireMeter`), so a card and the panel beside it say the same speed.
 * @param item - the download, or undefined when the queue does not list it.
 * @param now - the clock; `Date.now` by default.
 * @returns the rate; empty unless the item is downloading.
 */
export function useDownloadRate(item: DownloadItem | undefined, now: () => number = Date.now): DownloadRate {
  const [meter, setMeter] = useState<{ readonly key: string, readonly rate: TransferRate } | undefined>(undefined)
  const [rate, setRate] = useState<DownloadRate>(NO_RATE)
  const key = item?.key
  const downloading = item?.state === 'downloading'
  const received = item?.receivedBytes ?? 0
  const total = item?.totalBytes
  useEffect(() => {
    if (key === undefined || !downloading) {
      setMeter(undefined)
      return undefined
    }
    setMeter({ key, rate: acquireMeter(key) })
    return () => { releaseMeter(key) }
  }, [key, downloading])
  useEffect(() => {
    // A meter acquired for another key is the one this render's change is about to replace.
    if (meter === undefined || meter.key !== key || !downloading) {
      setRate(NO_RATE)
      return undefined
    }
    const measured = meter.rate
    const read = (): void => {
      const at = now()
      measured.add(at, received)
      setRate(rateOf(measured, total, at))
    }
    read()
    // The timed reads fall on the clock's whole seconds, so every surface showing this download reads the shared meter
    // at the same moment and says the same speed.
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = (): void => {
      timer = setTimeout(() => { read(); next() }, RATE_READ_MS - (now() % RATE_READ_MS))
    }
    next()
    return () => { clearTimeout(timer) }
  }, [meter, key, downloading, received, total, now])
  return rate
}

/**
 * The words for a rate: `6.7 MB/s`, or `6.7 MB/s · ~14s left` with the time left.
 * @param rate - the rate.
 * @param t - the copy.
 * @returns the text, or an empty string while the speed is not known.
 */
export function rateText(rate: DownloadRate, t: Translate): string {
  if (rate.speed === undefined) return ''
  const speed = formatSpeed(rate.speed)
  return rate.secondsLeft === undefined ? speed : t('rate.speedLeft', { speed, time: formatRemaining(rate.secondsLeft) })
}
