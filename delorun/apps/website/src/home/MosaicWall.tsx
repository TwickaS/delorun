/**
 * One layout of the home page's mosaic: the tiles on a grid, in the page's look, with the tint layers over them.
 *
 * - The first paint is one picture, the look's atlas (L0), over a one-pixel-per-cell placeholder; the tiles are
 *   transparent buttons over it. A tile shown larger than its atlas cell (hover, focus, the zoom) gets its own picture
 *   at the level it needs (`tile-lod.ts`).
 * - Pressing the header's theme control re-tiles the mark in the new look: once the new look's atlas has loaded, the
 *   tiles turn to their cell of it ring by ring, outward from the control, and the new atlas then replaces the old one.
 *   Under reduced motion they change at once.
 * - One tile beside the plug, the living tile, plays a real chat in the current look: the agent at work, then done.
 *   Looks without that capture show the cell's still picture.
 * - The mosaic is one stop for the Tab key; the arrow keys, Home and End move between tiles. Hover and focus lift a
 *   tile and show its screen and look; a press opens it in the lightbox.
 *
 * Over the pinned tile sit the full-size captures the film shows, which line up exactly with the hand-over copy: the
 * dark one always, and in light looks the light one, fading in early in the zoom.
 *
 * @module @delorun/website/home/mosaic-wall
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type FocusEvent } from 'react'
import { getLook } from '@design/look-store.ts'
import { livingFrames, type Layout } from './mosaic.ts'
import { MOSAIC_PLANS, PLAN_IDS } from './mosaic-plans.ts'
import { planCells, planLook, type LayoutName, type PlanLook, type PlanMode } from './plans.ts'
import { MS } from './motion.ts'
import { onRetile } from './retile.ts'
import { LOD_ATLASES } from './lod-atlases.ts'
import { atlasUrl, imageSet, lodUrl, preferredFormat, shotSrc, useArmed } from './pictures.ts'
import { FILM, SCREEN_LABELS, SHOTS, TONE_NAMES, type Shot } from './shots.ts'
import { clearStale, upgradeTile } from './tile-lod.ts'
import { Tile } from './Wall.tsx'
import s from './home.module.css'

/** The film's first chapter, whose picture the zoom hands over to. */
const HANDOVER = FILM[0]

/** How far apart the re-tile's rings are, in pixels, and how long each waits after the last, in milliseconds. */
const RING = 110
const RING_STEP = MS.press / 2

/** How long one tile takes to turn, in milliseconds; the stylesheet's `tileTurn` animation lasts as long. */
const TURN = MS.explain

/**
 * The style that shows one cell of an atlas, for a tile turning to a new look.
 * @param name - the layout.
 * @param look - the look.
 * @param mode - the colour scheme.
 * @param index - the cell.
 * @param cols - the layout's columns.
 * @returns the style.
 */
function spriteStyle(name: LayoutName, look: PlanLook, mode: PlanMode, index: number, cols: number) {
  const { cell: [cw, ch], gap, width, height } = LOD_ATLASES[name]
  const x = (index % cols) * (cw + gap)
  const y = Math.floor(index / cols) * (ch + gap)
  return {
    backgroundImage: imageSet(atlasUrl(name, look, mode, 'avif'), atlasUrl(name, look, mode, 'webp')),
    backgroundSize: `${(width / cw) * 100}% ${(height / ch) * 100}%`,
    backgroundPosition: `${(x / (width - cw)) * 100}% ${(y / (height - ch)) * 100}%`,
  }
}

/** How long the living tile holds each frame, in milliseconds. */
const LIVING_HOLD = [2600, 3800] as const

const BY_ID = new Map(SHOTS.map(shot => [shot.id, shot]))
const parts = new Map<LayoutName, readonly string[]>()
const cache = new Map<string, readonly Shot[]>()

/**
 * A layout's pictures in a look and colour scheme, cell by cell.
 * @param name - the layout.
 * @param look - the look.
 * @param mode - the colour scheme.
 * @returns the pictures, by row.
 */
function cellsFor(name: LayoutName, look: PlanLook, mode: PlanMode): readonly Shot[] {
  const key = `${name}:${look}:${mode}`
  const known = cache.get(key)
  if (known !== undefined) return known
  const shots = planCells(name, look, mode).map(index => {
    const shot = BY_ID.get(PLAN_IDS[index] ?? '')
    if (shot === undefined) throw new Error(`The mosaic plan names a picture that is not one of the shots: ${PLAN_IDS[index] ?? index}`)
    return shot
  })
  cache.set(key, shots)
  return shots
}

/**
 * The page's colour scheme, kept current: `dark` until the page has mounted, since the prerendered page cannot know it.
 * @returns the scheme.
 */
function useMode(): PlanMode {
  const [mode, setMode] = useState<PlanMode>('dark')
  useEffect(() => {
    const root = document.documentElement
    const read = () => setMode(root.classList.contains('dark') ? 'dark' : 'light')
    read()
    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return mode
}

/**
 * A layout's cells' parts of the mark, by row.
 * @param name - the layout.
 * @returns `n` nut, `h` hole, `p` plug or `o` around, per cell.
 */
function partsFor(name: LayoutName): readonly string[] {
  const known = parts.get(name)
  if (known !== undefined) return known
  const list = [...MOSAIC_PLANS[name].parts]
  parts.set(name, list)
  return list
}

/**
 * The short line a tile shows on hover and focus.
 * @param shot - the picture.
 * @returns its screen and look, such as `Settings · Ocean`.
 */
function tileLabel(shot: Shot): string {
  return `${SCREEN_LABELS[shot.screen]}, ${shot.theme ?? TONE_NAMES[shot.tone]}`
}

/**
 * Waits.
 * @param ms - how long, in milliseconds.
 * @returns a promise that settles after that long.
 */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => { window.setTimeout(resolve, ms) })
}

/** The wall's look, and while it re-tiles, the look it turns to and how far the turn has spread. */
interface Turning {
  readonly look: PlanLook
  readonly to?: PlanLook
  /** Each cell's ring, counted from the theme control outward. */
  readonly rings?: Int16Array
  /** The last ring that has turned. */
  readonly ring: number
}

/**
 * The living tile: plays its frames in turn, each fading in over the last, and holds still under reduced motion.
 * @param props.frames - the frames, in order.
 * @param props.cell - the cell's index.
 * @param props.tabIndex - its place in the Tab order.
 * @param props.onFocus - called when it takes focus.
 * @returns the tile.
 */
function LivingTile({ frames, cell, tabIndex, onFocus }: { frames: readonly Shot[]; cell: number; tabIndex: number; onFocus: () => void }) {
  const [frame, setFrame] = useState(0)
  const own = useRef<HTMLSpanElement>(null)
  // The atlas already shows the first frame; the sharper pictures wait for the first scroll or the idle moment.
  const armed = useArmed()
  useEffect(() => {
    setFrame(0)
    if (frames.length < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let at = 0
    let timer = 0
    const step = () => {
      timer = window.setTimeout(() => {
        // While the page zooms the tile holds its frame, so the sharper copy the zoom gives it stays right.
        if (own.current?.closest('[data-zooming]') == null) { at = (at + 1) % frames.length; setFrame(at) }
        step()
      }, LIVING_HOLD[at % LIVING_HOLD.length])
    }
    step()
    return () => { window.clearTimeout(timer) }
  }, [frames])
  const shot = frames[frame % frames.length] ?? frames[0]
  // A sharper copy the zoom gave the last frame goes with it.
  useEffect(() => { const button = own.current?.closest<HTMLElement>('[data-shot]'); if (button != null) clearStale(button) }, [shot])
  if (shot === undefined) return null
  return (
    <Tile shot={shot} bare className={`${s.mosaicTile} ${s.livingTile}`} cell={cell} tabIndex={tabIndex} onFocus={onFocus} label={`${tileLabel(shot)}, live`}>
      <span ref={own} hidden />
      {armed
        ? (
            <picture key={shot.id}>
              <source type="image/avif" srcSet={lodUrl(shot.id, 2, 'avif')} />
              <img className={s.livingFrame} src={lodUrl(shot.id, 2, 'webp')} alt="" draggable={false} />
            </picture>
          )
        : null}
    </Tile>
  )
}

/**
 * One layout's wall.
 * @param props.name - the layout's name.
 * @param props.layout - the layout.
 * @returns the wall.
 */
export function MosaicWall({ name, layout }: { name: LayoutName; layout: Layout }) {
  const { cols, rows, pin } = layout
  const wall = useRef<HTMLDivElement>(null)
  const [turning, setTurning] = useState<Turning>({ look: 'soft', ring: 0 })
  const current = useRef(turning)
  current.current = turning
  const mode = useMode()
  const pinIndex = pin.row * cols + pin.col
  const [active, setActive] = useState(pinIndex)

  // The page may already have a look when the wall mounts.
  useEffect(() => {
    const look = planLook(getLook().look)
    if (look !== current.current.look) setTurning({ look, ring: 0 })
  }, [])

  useEffect(() => onRetile(async (target, run) => {
    const to = planLook(target)
    const el = wall.current
    if (to === (current.current.to ?? current.current.look)) return
    if (el === null || el.offsetParent === null || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTurning({ look: to, ring: 0 })
      return
    }
    const from = current.current.to ?? current.current.look
    const after = cellsFor(name, to, mode)
    // The new look's atlas is ready before the first tile turns, so no tile turns to a gap.
    const loader = new Image()
    loader.src = atlasUrl(name, to, mode, await preferredFormat())
    await loader.decode().catch((error: unknown) => {
      // The tiles still turn; each shows its cell's colour until the browser has the atlas.
      console.warn('The mosaic atlas could not load before the re-tile', to, error)
    })
    const control = document.querySelector('[data-theme-control]')?.getBoundingClientRect()
    const ox = control === undefined ? innerWidth : control.left + control.width / 2
    const oy = control === undefined ? 0 : control.top + control.height / 2
    const rings = new Int16Array(after.length)
    let last = 0
    el.querySelectorAll<HTMLElement>('[data-cell]').forEach(button => {
      const index = Number(button.dataset['cell'])
      const box = button.getBoundingClientRect()
      const ring = Math.floor(Math.hypot(box.left + box.width / 2 - ox, box.top + box.height / 2 - oy) / RING)
      rings[index] = ring
      last = Math.max(last, ring)
    })
    setTurning({ look: from, to, rings, ring: -1 })
    for (let ring = 0; ring <= last; ring++) {
      await wait(RING_STEP / run.speed())
      setTurning(now => now.to === to ? { ...now, ring } : now)
    }
    await wait(TURN / run.speed())
    setTurning({ look: to, ring: 0 })
  }), [name, mode])

  const shownLook = (index: number): PlanLook => {
    const { look, to, rings, ring } = turning
    return to !== undefined && rings !== undefined && (rings[index] ?? 0) <= ring ? to : look
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const col = active % cols
    const row = Math.floor(active / cols)
    const next = {
      ArrowLeft: row * cols + Math.max(0, col - 1),
      ArrowRight: row * cols + Math.min(cols - 1, col + 1),
      ArrowUp: Math.max(0, row - 1) * cols + col,
      ArrowDown: Math.min(rows - 1, row + 1) * cols + col,
      Home: row * cols,
      End: row * cols + cols - 1,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
    wall.current?.querySelector<HTMLElement>(`[data-cell="${next}"]`)?.focus()
  }

  const armed = useArmed()

  // Layers a re-tile left on tiles that now hold another picture.
  useEffect(() => { if (wall.current !== null) clearStale(wall.current) })

  // Hover and focus show a tile lifted, so it gets the level that size needs.
  const atlas = LOD_ATLASES[name]
  const lift = (event: PointerEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-shot]') : null
    if (button === null || wall.current?.closest('[data-zooming]') != null) return
    // A lifted tile stands above the atlas, so it always needs its own picture.
    upgradeTile(button, button.getBoundingClientRect().width * 1.1 * devicePixelRatio, 0)
  }

  const partList = partsFor(name)
  const rect = (index: number) => <rect key={index} x={index % cols} y={Math.floor(index / cols)} width={1} height={1} />
  const indexes = partList.map((_, index) => index)
  const live = MOSAIC_PLANS[name].looks[turning.look][mode].live
  const base = turning.look
  return (
    <div
      ref={wall}
      className={s.mosaic}
      data-layout={name}
      data-retiling={turning.to === undefined ? undefined : ''}
      style={{
        ['--cols' as string]: cols,
        ['--rows' as string]: rows,
        ['--ratio' as string]: `${atlas.width} / ${atlas.height}`,
        columnGap: `${(atlas.gap / atlas.width) * 100}%`,
        rowGap: `${(atlas.gap / atlas.height) * 100}%`,
        ['--cell-w' as string]: `${(atlas.cell[0] / atlas.width) * 100}%`,
        ['--cell-h' as string]: `${(atlas.cell[1] / atlas.height) * 100}%`,
        ['--step-x' as string]: `${((atlas.cell[0] + atlas.gap) / atlas.width) * 100}%`,
        ['--step-y' as string]: `${((atlas.cell[1] + atlas.gap) / atlas.height) * 100}%`,
      }}
      role="group"
      aria-label="The Delorun mark, made of real screens. Arrow keys move between them; Enter opens one."
      onKeyDown={onKeyDown}
      onPointerOver={lift}
      onFocus={lift}
    >
      {/* The prerendered page cannot know the colour scheme, so both atlases are in it and the stylesheet shows one. */}
      {(['dark', 'light'] as const).map(each => (
        <div key={each} className={s.mosaicLayers} data-mode={each} aria-hidden="true">
          <div className={s.mosaicTiny} style={{ backgroundImage: `url("${atlas.tiny[base][each]}")` }} />
          <div className={s.mosaicAtlas} style={{ backgroundImage: imageSet(atlasUrl(name, base, each, 'avif'), atlasUrl(name, base, each, 'webp')) }} />
        </div>
      ))}
      {indexes.map(index => {
        const look = shownLook(index)
        const tabIndex = index === active ? 0 : -1
        const focus = () => setActive(index)
        const frames = index === live ? livingFrames(look) : []
        if (frames.length > 0) return <LivingTile key={index} frames={frames} cell={index} tabIndex={tabIndex} onFocus={focus} />
        const shot = cellsFor(name, look, mode)[index]
        if (shot === undefined) return null
        return (
          <Tile key={index} shot={shot} bare className={s.mosaicTile} pinned={index === pinIndex} cell={index} tabIndex={tabIndex} onFocus={focus} label={tileLabel(shot)}>
            {look === base ? null : <span key={look} className={s.tileSprite} style={spriteStyle(name, look, mode, index, cols)} />}
          </Tile>
        )
      })}
      {HANDOVER === undefined ? null : (
        <>
          <img className={s.pinSwap} data-always="" src={armed ? shotSrc(HANDOVER.dark?.id ?? HANDOVER.id, 'full') : undefined} loading="lazy" alt="" aria-hidden="true" draggable={false} style={{ ['--col' as string]: pin.col, ['--row' as string]: pin.row }} />
          <img className={`${s.pinSwap} ${s.lightOnly}`} data-swap="" src={armed ? shotSrc(HANDOVER.id, 'full') : undefined} loading="lazy" alt="" aria-hidden="true" draggable={false} style={{ ['--col' as string]: pin.col, ['--row' as string]: pin.row }} />
        </>
      )}
      <svg className={s.mosaicShade} data-tint="" viewBox={`0 0 ${cols} ${rows}`} preserveAspectRatio="none" aria-hidden="true">
        {indexes.filter(index => (partList[index] === 'o' || partList[index] === 'h') && index !== pinIndex && index !== live).map(rect)}
      </svg>
      <svg className={s.mosaicPeach} data-tint="" viewBox={`0 0 ${cols} ${rows}`} preserveAspectRatio="none" aria-hidden="true">
        {indexes.filter(index => partList[index] === 'p').map(rect)}
      </svg>
    </div>
  )
}
