/**
 * The home page's first screen: the photomosaic of the Delorun mark, with the promise and the install command beside it
 * (below it on a phone). Scrolling down zooms into one chat in the mark's hole until it fills the place where the next
 * section's first picture sits; the words leave first, the tint and the other tiles fade, the full picture fades in over
 * the tile, and the next section, which slides up under this one, takes over with the same picture in the same place.
 * Only transforms and opacity change while scrolling. Under reduced motion the hero stays formed and the next section
 * follows as normal. Every tile opens the untouched screenshot in the lightbox.
 *
 * @module @delorun/website/home/mosaic-hero
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { NARROW, WIDE, type Layout } from './mosaic.ts'
import { MosaicWall } from './MosaicWall.tsx'
import type { LayoutName } from './plans.ts'
import { note } from './effects.ts'
import { LOD_ATLASES } from './lod-atlases.ts'
import { arm, shotSrc, useArmed } from './pictures.ts'
import { FILM, SIZES } from './shots.ts'
import { upgradeTile } from './tile-lod.ts'
import { Tile } from './Wall.tsx'
import s from './home.module.css'

/** The layouts, each shown at its own widths by the stylesheet. */
const LAYOUTS: readonly { readonly name: LayoutName; readonly layout: Layout }[] = [
  { name: 'wide', layout: WIDE },
  { name: 'narrow', layout: NARROW },
]


/** A tile's place in the wall with no zoom. */
interface TilePicture {
  readonly button: HTMLElement
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** How long the scroll must pause, in milliseconds, before the zoom loads sharper tiles. */
const SETTLE = 140

/** How far the zoom may stretch the atlas, as a multiple of its cell's pixels, before a tile loads its own picture. */
const ATLAS_STRETCH = 1.5

/** How long after the page loads the zoom's full-size pictures start loading with no scroll or input, in milliseconds. */
const IDLE_ARM = 2500

/** The film's first chapter, whose picture the zoom hands over to. */
const HANDOVER = FILM[0]

/**
 * A value's progress through a range, held between 0 and 1.
 * @param value - the value.
 * @param from - where the range starts.
 * @param to - where it ends.
 * @returns the progress.
 */
function progress(value: number, from: number, to: number): number {
  return Math.min(1, Math.max(0, (value - from) / (to - from)))
}

/**
 * Eases in and out, so the zoom starts and settles gently.
 * @param t - linear progress, 0 to 1.
 * @returns eased progress.
 */
function ease(t: number): number {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
}

/**
 * The hero.
 * @param props.children - the promise and the install command.
 * @param props.next - the id of the next section's heading; that section's `[data-handover]` picture is where the zoom
 * ends.
 * @returns the section.
 */
export function MosaicHero({ children, next }: { children: ReactNode; next: string }) {
  const section = useRef<HTMLElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const handover = useRef<HTMLDivElement>(null)
  const cover = useRef<HTMLDivElement>(null)
  const armed = useArmed()

  // The zoom's full-size pictures load on the first scroll or input, or once the page has idled after loading.
  useEffect(() => {
    const events = ['scroll', 'wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    for (const name of events) addEventListener(name, arm, { once: true, passive: true })
    let timer = 0
    const idle = () => { timer = window.setTimeout(arm, IDLE_ARM) }
    if (document.readyState === 'complete') idle()
    else addEventListener('load', idle, { once: true })
    return () => {
      for (const name of events) removeEventListener(name, arm)
      removeEventListener('load', idle)
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const root = section.current
    const frame = stage.current
    const picture = handover.current
    const field = cover.current
    if (root === null || frame === null || picture === null || field === null) return
    const still = matchMedia('(prefers-reduced-motion: reduce)')
    let pending = 0
    let settle = 0
    // The readout logs the zoom once each time it starts from the formed mark.
    let logged = false
    // The wall's and the pinned tile's places with no zoom, in fractional pixels from the stage's corner. Whole-pixel
    // offsets would be multiplied by the zoom and leave the tile and the full copy visibly apart.
    let rest: { readonly wall: HTMLElement; readonly x: number; readonly y: number; readonly tileX: number; readonly tileY: number; readonly tileW: number; readonly tileH: number; readonly tiles: readonly TilePicture[] } | undefined
    const measure = (wall: HTMLElement, tile: HTMLElement) => {
      const before = wall.style.transform
      wall.style.transform = 'none'
      const origin = frame.getBoundingClientRect()
      const w = wall.getBoundingClientRect()
      const t = tile.getBoundingClientRect()
      wall.style.transform = before
      const tiles = [...wall.querySelectorAll<HTMLElement>('[data-shot]')].map(button => ({ button, left: button.offsetLeft, top: button.offsetTop, width: button.offsetWidth, height: button.offsetHeight }))
      return { wall, x: w.left - origin.left, y: w.top - origin.top, tileX: t.left - w.left + t.width / 2, tileY: t.top - w.top, tileW: t.width, tileH: t.height, tiles }
    }

    const update = () => {
      pending = 0
      const plan = LAYOUTS.find(each => frame.querySelector<HTMLElement>(`[data-layout="${each.name}"]`)?.offsetParent !== null)
      const wall = plan === undefined ? null : frame.querySelector<HTMLElement>(`[data-layout="${plan.name}"]`)
      const tile = wall?.querySelector<HTMLElement>('[data-pinned]')
      const nextSection = document.getElementById(next)?.closest('section')
      const target = nextSection?.querySelector<HTMLElement>('[data-handover]')
      if (wall == null || tile == null || nextSection == null || target == null) return
      const box = root.getBoundingClientRect()
      const p = still.matches ? 0 : progress(-box.top, 0, Math.max(1, box.height - innerHeight))

      // Where the next section's first picture sits once that section has reached the top of the window.
      const goal = target.getBoundingClientRect()
      const offset = Math.max(0, nextSection.getBoundingClientRect().top)
      // The zoom aims the tile's top centre at the goal's top centre: both pictures are anchored at the top, so the tile
      // and the full copy over it line up even where their proportions differ by a pixel or two.
      const goalX = goal.left + goal.width / 2
      const goalY = goal.top - offset
      // The pinned tile's top centre, in the wall's own coordinates and on screen at rest.
      if (rest?.wall !== wall) rest = measure(wall, tile)
      const { tileX, tileY, tileW, tileH } = rest
      const restX = rest.x + tileX
      const restY = rest.y + tileY
      const end = goal.width / tileW

      const e = ease(progress(p, 0.1, 0.84))
      const scale = end ** e
      const nowX = restX + (goalX - restX) * e
      const nowY = restY + (goalY - restY) * e
      wall.style.transform = `translate(${nowX - rest.x - scale * tileX}px, ${nowY - rest.y - scale * tileY}px) scale(${scale})`

      // Once the scroll pauses mid-zoom, the tiles on screen take the level their size will need a little further in,
      // where the atlas would show at under two thirds of a pixel per screen pixel. While the page scrolls on, nothing
      // loads: those tiles pass in a moment.
      window.clearTimeout(settle)
      // Past the point where the field starts covering the tiles, none need a larger copy.
      if (p > 0.02 && p < 0.74) {
        const ahead = end ** ease(progress(p + 0.04, 0.1, 0.84))
        const atlasCell = LOD_ATLASES[rest.wall.dataset['layout'] === 'narrow' ? 'narrow' : 'wide'].cell[0] * ATLAS_STRETCH
        const tiles = rest.tiles
        settle = window.setTimeout(() => {
          for (const each of tiles) {
            // The pinned tile needs none: the full captures cover it.
            if (each.button === tile) continue
            const x = nowX + scale * (each.left - tileX)
            const y = nowY + scale * (each.top - tileY)
            if (x > innerWidth || y > innerHeight || x + each.width * scale < 0 || y + each.height * scale < 0) continue
            upgradeTile(each.button, each.width * Math.max(scale, ahead) * devicePixelRatio, atlasCell)
          }
        }, SETTLE)
      }

      // The full picture, laid out at the goal's size and scaled to the tile's width, takes over from the tile early,
      // while the zoom is still small: the browser draws pictures inside the zoomed wall at whole pixels of the wall's
      // own size, so later the tile could sit a few screen pixels off. It starts cut to the tile's proportions and opens
      // to the goal's as the zoom ends.
      const k = (tileW * scale) / goal.width
      const cut = Math.max(0, 1 - (tileH / tileW) / (goal.height / goal.width)) * (1 - progress(p, 0.5, 0.84))
      picture.style.width = `${goal.width}px`
      picture.style.height = `${goal.height}px`
      picture.style.transform = `translate(${nowX - (goal.width * k) / 2}px, ${nowY}px) scale(${k})`
      picture.style.clipPath = `inset(0 0 ${(cut * 100).toFixed(2)}% 0 round ${12}px)`
      picture.style.opacity = String(progress(p, 0.3, 0.4))

      const tint = String(1 - progress(p, 0.08, 0.4))
      wall.querySelectorAll<SVGElement>('[data-tint]').forEach(layer => { layer.style.opacity = tint })
      // Each value goes on the elements that read it. A custom property set on the stage would be inherited by every tile
      // under it, and the browser would recalculate the style of the whole mosaic on every frame of the zoom.
      const words = String(1 - progress(p, 0.03, 0.2))
      frame.querySelectorAll<HTMLElement>('[data-words]').forEach(layer => { layer.style.setProperty('--words', words) })
      frame.toggleAttribute('data-zooming', p > 0.02)
      if (p < 0.02) logged = false
      else if (p > 0.12 && !logged) { logged = true; note('zoom → chat') }
      tile.style.setProperty('--lit', String(progress(p, 0.01, 0.08) * (1 - progress(p, 0.14, 0.3))))
      const swap = String(progress(p, 0.12, 0.28))
      wall.querySelectorAll<HTMLElement>('[data-swap]').forEach(layer => { layer.style.setProperty('--swap', swap) })
      field.style.setProperty('--field-in', String(progress(p, 0.7, 0.84)))
      frame.style.opacity = String(1 - progress(p, 0.9, 0.99))
    }
    const schedule = () => { if (pending === 0) pending = requestAnimationFrame(update) }
    const resized = () => { rest = undefined; schedule() }
    update()
    void document.fonts.ready.then(resized)
    addEventListener('scroll', schedule, { passive: true })
    addEventListener('resize', resized)
    still.addEventListener('change', schedule)
    return () => {
      cancelAnimationFrame(pending)
      window.clearTimeout(settle)
      removeEventListener('scroll', schedule)
      removeEventListener('resize', resized)
      still.removeEventListener('change', schedule)
    }
  }, [next])

  return (
    <section ref={section} className={s.reveal} aria-labelledby="home-hero">
      <div ref={stage} className={s.revealStage}>
        <div className={s.revealTop} data-words="" aria-hidden="true" />
        <div className={s.mosaicFrame}>
          {LAYOUTS.map(each => <MosaicWall key={each.name} name={each.name} layout={each.layout} />)}
        </div>
        <div ref={cover} className={s.revealField} aria-hidden="true" />
        <div ref={handover} className={s.handover} aria-hidden="true">
          {HANDOVER === undefined ? null : (
            <>
              <img className={`${s.handoverWide} ${s.lightOnly}`} src={armed ? shotSrc(HANDOVER.id, 'full') : undefined} loading="lazy" alt="" draggable={false} />
              <img className={`${s.handoverWide} ${s.darkOnly}`} src={armed ? shotSrc(HANDOVER.dark?.id ?? HANDOVER.id, 'full') : undefined} loading="lazy" alt="" draggable={false} />
              <img className={s.handoverNarrow} src={armed ? shotSrc(HANDOVER.phone.file, 'full') : undefined} loading="lazy" alt="" draggable={false} />
            </>
          )}
        </div>
        <div className={s.revealShade} data-words="" aria-hidden="true" />
        <div className={s.revealWords} data-words="">{children}</div>
      </div>
    </section>
  )
}
