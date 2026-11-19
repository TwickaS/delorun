/**
 * The wall: every screenshot as a tile on one grid, in one mixed order. Pressing a tile opens it large.
 *
 * @module @delorun/website/home/wall
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { fullWidth, LEVEL_WIDTHS, lodUrl, type Format } from './pictures.ts'
import { useOpenShot } from './Lightbox.tsx'
import { SHOTS, type Shot } from './shots.ts'
import s from './home.module.css'

/**
 * One tile: a button holding the screenshot.
 * @param props.shot - the picture.
 * @param props.feature - true to show it larger.
 * @param props.hidden - true for a decorative copy that is not reachable by keyboard or screen reader.
 * @param props.extra - true for a tile a phone hides until the visitor asks for all of them.
 * @param props.beyond - true for a tile any screen hides until the visitor asks for all of them.
 * @param props.eager - true to load the picture at once, for tiles a transform brings into view without scrolling.
 * @param props.pinned - true for the mosaic's tile that the page zooms into.
 * @param props.bare - true for a mosaic tile, which shows the atlas under it and gets pictures from script.
 * @param props.children - layers inside the tile, such as a mosaic tile's re-tile picture.
 * @param props.cell - the tile's cell in the mosaic, for keyboard movement between tiles.
 * @param props.tabIndex - the tile's place in the Tab order, where a container moves focus between its tiles.
 * @param props.onFocus - called when the tile takes focus.
 * @param props.label - a short line shown on hover and focus, such as the screen and the look.
 * @param props.style - extra style.
 * @param props.className - extra class.
 * @returns the tile.
 */
export function Tile({ shot, feature = false, hidden = false, extra = false, beyond = false, eager = false, pinned = false, bare = false, children, cell, tabIndex, onFocus, label, style, className }: { shot: Shot; feature?: boolean; hidden?: boolean; extra?: boolean; beyond?: boolean; eager?: boolean; pinned?: boolean; bare?: boolean; children?: ReactNode; cell?: number; tabIndex?: number; onFocus?: () => void; label?: string; style?: CSSProperties; className?: string }) {
  const open = useOpenShot()
  return (
    <button
      type="button"
      className={`${s.tile} ${className ?? ''}`}
      data-device={shot.device}
      data-feature={feature}
      data-shot={shot.id}
      data-extra={extra || undefined}
      data-beyond={beyond || undefined}
      data-pinned={pinned || undefined}
      data-cell={cell}
      style={style}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : tabIndex}
      onFocus={onFocus}
      onClick={event => open(shot.id, event.currentTarget)}
      aria-label={hidden ? undefined : `Enlarge: ${shot.caption}`}
    >
      {bare ? null : (
        <picture key={shot.id}>
          <source type="image/avif" srcSet={srcSet(shot, 'avif')} sizes={feature ? WALL_SIZES.feature : WALL_SIZES.tile} />
          <img src={lodUrl(shot.id, 2, 'webp')} srcSet={srcSet(shot, 'webp')} sizes={feature ? WALL_SIZES.feature : WALL_SIZES.tile} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} />
        </picture>
      )}
      {children}
      {label === undefined ? null : <span className={s.tileLabel} aria-hidden="true">{label}</span>}
    </button>
  )
}

/** The widths a wall tile is shown at, for the browser's pick between L2 and L3. */
const WALL_SIZES = { tile: '(max-width: 639px) 50vw, (max-width: 1023px) 25vw, 16vw', feature: '(max-width: 639px) 100vw, (max-width: 1023px) 50vw, 33vw' } as const

/**
 * A wall tile's `srcset`: its L2 and L3 copies.
 * @param shot - the picture.
 * @param format - the format.
 * @returns the value.
 */
function srcSet(shot: Shot, format: Format): string {
  const widths = LEVEL_WIDTHS[shot.device]
  return `${lodUrl(shot.id, 2, format)} ${widths[1]}w, ${lodUrl(shot.id, 3, format)} ${fullWidth(shot.id)}w`
}

/** How many tiles a phone shows before the visitor asks for all of them. */
const PHONE_FIRST = 24

/** How many tiles a wider screen shows before the visitor asks for all of them. */
const WIDE_FIRST = 72

/**
 * The wall: every screenshot as a small tile on one grid, wider than the page's text; the lightbox is for reading one.
 * @param props.heading - the section's heading.
 * @param props.lead - the line under it.
 * @param props.id - the heading's id.
 * @returns the section.
 */
export function Wall({ heading, lead, id }: { heading: string; lead: string; id: string }) {
  const [collapsed, setCollapsed] = useState(true)
  return (
    <section aria-labelledby={id} className={s.wallSection}>
      <div className={s.wallHead}>
        <h2 id={id} className={s.sectionTitle}>{heading}</h2>
        <p className={s.wallLead}>{lead}</p>
        <div className={s.wallControls}>
          <span className={s.wallCount}><strong>{SHOTS.length}</strong> real screens</span>
        </div>
      </div>
      <div className={s.wallGrid} data-collapsed={collapsed}>
        {SHOTS.map((shot, index) => <Tile key={shot.id} shot={shot} feature={shot.feature === true} extra={index >= PHONE_FIRST} beyond={index >= WIDE_FIRST} />)}
      </div>
      {collapsed ? <button type="button" className={s.showAll} data-wide={SHOTS.length > WIDE_FIRST} onClick={() => setCollapsed(false)}>Show all {SHOTS.length}</button> : null}
    </section>
  )
}
