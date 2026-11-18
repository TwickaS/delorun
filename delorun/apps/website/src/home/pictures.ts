/**
 * Addresses and loading for the home page's level-of-detail pictures in `/lod/` (built by `scripts/lod.ts`):
 * L0 mosaic atlases, then L1 (96 px), L2 (480 px, or 300 for a phone capture) and L3 (full size) of every picture, each
 * as AVIF and WebP with a content hash in its name. Pictures loaded from script go through one queue that runs a few
 * at a time, newest request first, and drops requests nobody wants any more, so a fast scroll never queues hundreds.
 *
 * @module @delorun/website/home/pictures
 */
import { useSyncExternalStore } from 'react'
import { LOD_ATLASES } from './lod-atlases.ts'
import { LOD_TILES } from './lod-tiles.ts'
import type { PlanLook, PlanMode } from './plans.ts'
import { SHOTS, type Device } from './shots.ts'

/** A picture's level of detail: L1 tile, L2 zoom and wall, L3 full size. */
export type Level = 1 | 2 | 3

/** A picture format the pyramid has. */
export type Format = 'avif' | 'webp'

/** Each level's width in pixels, by device; L3 is the capture's own width. */
export const LEVEL_WIDTHS: Readonly<Record<Device, readonly [number, number, number]>> = { computer: [96, 480, 1440], phone: [96, 300, 390] }

/**
 * The level a picture needs to look sharp at a size on screen.
 * @param needed - the picture's width on screen, in device pixels.
 * @param device - the kind of capture, which sets the level widths.
 * @returns the smallest level that is at least as wide as `needed`, or the full size when none is.
 */
export function levelFor(needed: number, device: Device): Level {
  const widths = LEVEL_WIDTHS[device]
  return needed <= widths[0] ? 1 : needed <= widths[1] ? 2 : 3
}

/**
 * The address of one level of a picture.
 * @param id - the picture.
 * @param level - the level.
 * @param format - the format.
 * @returns the address.
 */
export function lodUrl(id: string, level: Level, format: Format): string {
  const hash = LOD_TILES[id]?.[level - 1]
  if (hash === undefined) throw new Error(`The picture ${id} has no level ${level}; run scripts/lod.ts tiles`)
  return `/lod/${id}.${level}.${hash}.${format}`
}

/**
 * The address of a picture in the sizes the older code names, as WebP.
 * @param id - the picture.
 * @param size - `mini` for L1, `thumb` for L2, `full` for L3.
 * @returns the address.
 */
export function shotSrc(id: string, size: 'mini' | 'thumb' | 'full'): string {
  return lodUrl(id, size === 'mini' ? 1 : size === 'thumb' ? 2 : 3, 'webp')
}

/** A mosaic layout the atlases cover. */
export type AtlasLayout = keyof typeof LOD_ATLASES

/**
 * The address of a mosaic atlas.
 * @param layout - the layout.
 * @param look - the look.
 * @param mode - the colour scheme.
 * @param format - the format.
 * @returns the address.
 */
export function atlasUrl(layout: AtlasLayout, look: PlanLook, mode: PlanMode, format: Format): string {
  return `/lod/atlas-${layout}-${look}-${mode}.${LOD_ATLASES[layout].looks[look][mode]}.${format}`
}

/**
 * A CSS `image-set()` offering AVIF, then WebP.
 * @param avif - the AVIF address.
 * @param webp - the WebP address.
 * @returns the value for `background-image`.
 */
export function imageSet(avif: string, webp: string): string {
  return `image-set(url("${avif}") type("image/avif"), url("${webp}") type("image/webp"))`
}

let probe: Promise<Format> | undefined
let found: Format = 'webp'

/**
 * The format found so far: WebP until {@link preferredFormat} has found AVIF decodes.
 * @returns the format.
 */
export function currentFormat(): Format {
  return found
}

/**
 * The format this browser decodes, found once by decoding the smallest AVIF the page has.
 * @returns AVIF when it decodes, otherwise WebP.
 */
export function preferredFormat(): Promise<Format> {
  if (probe !== undefined) return probe
  const first = SHOTS[0]
  if (first === undefined) return Promise.resolve('webp')
  const img = new Image()
  img.src = lodUrl(first.id, 1, 'avif')
  probe = img.decode().then(() => { found = 'avif'; return 'avif' as const }, () => 'webp' as const)
  return probe
}

let armed = false
const armedListeners = new Set<() => void>()

/**
 * Lets the zoom's full-size pictures load: called on the first scroll or input, or once the page has been idle a
 * moment after loading, so they are not part of the first screen's bytes but are ready before the zoom needs them.
 */
export function arm(): void {
  if (armed) return
  armed = true
  for (const listener of armedListeners) listener()
}

/**
 * Whether {@link arm} has been called.
 * @returns true once the zoom's full-size pictures may load.
 */
export function useArmed(): boolean {
  return useSyncExternalStore(listener => { armedListeners.add(listener); return () => { armedListeners.delete(listener) } }, () => armed, () => false)
}

/** How many pictures load at once from script. */
const IN_FLIGHT = 6

interface Job {
  readonly url: string
  readonly wanted: () => boolean
  readonly done: (img: HTMLImageElement | undefined) => void
}

const queue: Job[] = []
let inFlight = 0

/** Starts queued loads, newest first, while there is room; drops those no longer wanted. */
function pump(): void {
  while (inFlight < IN_FLIGHT && queue.length > 0) {
    const job = queue.pop()
    if (job === undefined) return
    if (!job.wanted()) { job.done(undefined); continue }
    inFlight++
    const img = new Image()
    img.src = job.url
    img.decode().then(() => job.done(img), (error: unknown) => {
      // A picture that fails leaves the copy on screen in place; the caller gets nothing to swap in.
      console.warn('A picture could not load', job.url, error)
      job.done(undefined)
    }).finally(() => { inFlight--; pump() })
  }
}

/**
 * Loads and decodes a picture through the queue.
 * @param url - the address.
 * @param wanted - asked when the load would start; false drops it.
 * @returns the decoded picture, or undefined when dropped or failed.
 */
export function load(url: string, wanted: () => boolean): Promise<HTMLImageElement | undefined> {
  return new Promise(done => { queue.push({ url, wanted, done }); pump() })
}
