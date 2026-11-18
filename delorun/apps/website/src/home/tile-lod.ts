/**
 * Raises a mosaic tile above the atlas when it is shown larger than the atlas's cell: on hover and focus, during the
 * zoom. The tile gets the level its size on screen needs, loaded through the picture queue and faded in over what it
 * showed before, so a tile never pops or empties. A tile showing another picture by the time the load ends is left
 * alone; {@link clearStale} removes layers left over from a re-tile.
 *
 * @module @delorun/website/home/tile-lod
 */
import { LEVEL_WIDTHS, load, lodUrl, preferredFormat, type Level } from './pictures.ts'
import s from './home.module.css'

/** How long a new layer takes to fade in, in milliseconds; matches `.tileLayer`'s transition. */
const FADE = 220

/**
 * Gives a tile the level its size on screen needs.
 * @param button - the tile.
 * @param needed - the tile's width on screen in device pixels.
 * @param atlasCell - the width of the tile's cell in the atlas, in pixels; below it the atlas is sharp enough.
 */
export function upgradeTile(button: HTMLElement, needed: number, atlasCell: number): void {
  const id = button.dataset['shot']
  if (id === undefined || needed <= atlasCell) return
  const widths = LEVEL_WIDTHS[button.dataset['device'] === 'phone' ? 'phone' : 'computer']
  const level: Level = needed <= widths[0] ? 1 : needed <= widths[1] ? 2 : 3
  const shown = button.dataset['levelFor'] === id ? Number(button.dataset['level'] ?? 0) : 0
  const asked = button.dataset['askedFor'] === id ? Number(button.dataset['asked'] ?? 0) : 0
  if (level <= Math.max(shown, asked)) return
  button.dataset['askedFor'] = id
  button.dataset['asked'] = String(level)
  // A load still queued when its tile has left the screen, or holds another picture, is dropped.
  const still = () => {
    if (!button.isConnected || button.dataset['shot'] !== id || Number(button.dataset['asked'] ?? 0) > level) return false
    const rect = button.getBoundingClientRect()
    const wanted = rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
    if (!wanted) button.dataset['asked'] = String(shown)
    return wanted
  }
  void preferredFormat().then(format => load(lodUrl(id, level, format), still)).then(img => {
    if (img === undefined || button.dataset['shot'] !== id) return
    const layer = document.createElement('img')
    layer.className = s.tileLayer ?? ''
    layer.alt = ''
    layer.draggable = false
    layer.src = img.src
    layer.dataset['for'] = id
    const below = [...button.querySelectorAll<HTMLElement>(`.${s.tileLayer ?? ''}`)]
    button.appendChild(layer)
    requestAnimationFrame(() => { layer.dataset['shown'] = '' })
    window.setTimeout(() => { for (const old of below) old.remove() }, FADE + 50)
    button.dataset['levelFor'] = id
    button.dataset['level'] = String(level)
  })
}

/**
 * Removes layers that show a picture their tile no longer holds, after a re-tile or a living tile's next frame.
 * @param root - the mosaic, or one tile.
 */
export function clearStale(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(`.${s.tileLayer ?? ''}`).forEach(layer => {
    const button = layer.closest<HTMLElement>('[data-shot]')
    if (button !== null && button.dataset['shot'] !== layer.dataset['for']) layer.remove()
  })
}
