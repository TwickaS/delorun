/**
 * The enlarged view of one screenshot. It grows out of the tile that was pressed and shrinks back into it; it closes on
 * Escape, a press on the backdrop, the close button or a swipe down, and steps through the pictures with the arrow keys,
 * the buttons or a swipe sideways. It is a modal `dialog`, so focus stays inside it and returns to the tile. The
 * picture sits over a caption plate like a gallery label: what the screen is, its look, device, language and
 * any setting it shows, and where it was captured; every fact comes from the picture itself or its source file name.
 *
 * @module @delorun/website/home/lightbox
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { note } from './effects.ts'
import { EASE, MS } from './motion.ts'
import { SHOT_COLOURS } from './shot-colours.ts'
import { currentFormat, lodUrl, preferredFormat } from './pictures.ts'
import { SCREEN_LABELS, SHOTS, SIZES, type Shot } from './shots.ts'
import s from './home.module.css'

/** Opens the view on a picture, growing from the given element. */
type Open = (id: string, from: HTMLElement) => void

const LightboxContext = createContext<Open>(() => undefined)

/**
 * The function that opens the view.
 * @returns the opener.
 */
export function useOpenShot(): Open {
  return useContext(LightboxContext)
}

/** The credit on the plate. */
const CREDIT = 'A real Delorun screenshot, scaled, not retouched.'

/**
 * The height kept free under the picture for the caption plate.
 * @returns the height in pixels.
 */
function reserve(): number {
  return innerWidth < 640 ? 250 : innerWidth < 1024 ? 200 : 160
}

/**
 * The rectangle the picture takes when open: as large as fits above the caption, inside the window's margins.
 * @param shot - the picture.
 * @returns its place.
 */
function openRect(shot: Shot): DOMRect {
  const { width, height } = SIZES[shot.device]
  const below = reserve()
  if (pans(shot)) {
    const h = innerHeight - below - 40
    return new DOMRect(0, 20, h * (width / height), h)
  }
  const phone = innerWidth < 640
  const maxW = innerWidth - (phone ? 24 : 160)
  const maxH = innerHeight - below - (phone ? 16 : 24)
  const scale = Math.min(maxW / width, maxH / height, shot.device === 'phone' ? 1.25 : 1.1)
  const w = width * scale
  const h = height * scale
  return new DOMRect((innerWidth - w) / 2, Math.max(phone ? 12 : 20, (innerHeight - below - h) / 2), w, h)
}

/**
 * The facts the plate lists for a picture.
 * @param shot - the picture.
 * @returns label and value pairs, in order.
 */
function facts(shot: Shot): readonly (readonly [string, string])[] {
  const tone = shot.tone === 'original' ? 'Original DeepSeek Harness look' : shot.tone === 'light' ? 'Light' : 'Dark'
  return [
    ['Screen', SCREEN_LABELS[shot.screen]],
    ['Look', shot.theme === undefined ? tone : `${shot.theme}, ${tone.toLowerCase()}`],
    ['Device', shot.device === 'phone' ? 'Phone' : 'Computer'],
    ['Language', shot.language ?? 'English'],
    ...shot.setting === undefined ? [] : [['Setting', shot.setting] as const],
  ]
}

/**
 * Whether the picture opens tall in a strip the visitor pans sideways: a computer screenshot on a phone, where fitting
 * its width would make the text unreadable.
 * @param shot - the picture.
 * @returns true to pan.
 */
function pans(shot: Shot): boolean {
  return innerWidth < 640 && shot.device === 'computer'
}

/**
 * The transform that puts the open picture over another rectangle.
 * @param from - the rectangle to start from.
 * @param to - the open rectangle.
 * @returns the CSS transform.
 */
function fromTransform(from: DOMRect, to: DOMRect): string {
  return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`
}

/**
 * The provider: renders the dialog and gives its descendants the opener.
 * @param props.children - the page.
 * @returns the provider.
 */
export function LightboxProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const picture = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const source = useRef<HTMLElement | null>(null)
  const closing = useRef(false)
  const [index, setIndex] = useState<number | undefined>(undefined)
  // Each open starts a new session, so a press while the last one closes opens again instead of being closed by it.
  const [session, setSession] = useState(0)
  const generation = useRef(0)
  // The best copy already on screen, shown at once; the full picture fades in over it once decoded.
  const [placeholder, setPlaceholder] = useState<string | undefined>(undefined)
  const [ready, setReady] = useState<string | undefined>(undefined)
  const shot = index === undefined ? undefined : SHOTS[index]
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches

  const open = useCallback<Open>((id, from) => {
    const at = SHOTS.findIndex(each => each.id === id)
    if (at < 0) return
    generation.current += 1
    source.current = from
    closing.current = false
    const shown = from.dataset['shot'] === id ? from.querySelector('img') : null
    setPlaceholder(shown !== null && shown.complete && shown.naturalWidth > 0 ? shown.currentSrc : undefined)
    setIndex(at)
    setSession(count => count + 1)
    const shot = SHOTS[at]
    if (shot !== undefined) note(`open ${SCREEN_LABELS[shot.screen].replace(/^A /, '').toLowerCase()} · ${shot.theme === undefined ? '' : `${shot.theme.replace(/,|\saccent/g, '')} `}${shot.tone === 'original' ? 'original' : shot.tone}`)
  }, [])

  // Each open grows the picture from its tile. Animations left by a close, finished or not, are cancelled first: a
  // close holds the dialog at no opacity until it shuts, and that hold would otherwise outlast the next open.
  useEffect(() => {
    const d = dialog.current
    const pic = picture.current
    if (session === 0 || shot === undefined || d === null || pic === null) return
    const shown = d.open ? Number(getComputedStyle(d).opacity) : 0
    for (const animation of [...d.getAnimations(), ...pic.getAnimations()]) animation.cancel()
    if (!d.open) d.showModal()
    const to = openRect(shot)
    const from = source.current?.getBoundingClientRect()
    Object.assign(pic.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, transform: '' })
    if (pans(shot) && strip.current !== null) strip.current.scrollLeft = (to.width - innerWidth) * 0.45
    if (from !== undefined && from.width > 0 && !still() && !pans(shot)) {
      pic.animate([{ transform: fromTransform(from, to), borderRadius: '12px' }, { transform: 'none' }], { duration: MS.scene, easing: EASE })
    }
    if (shown < 1) d.animate([{ opacity: shown }, { opacity: 1 }], { duration: MS.move, easing: EASE })
  }, [session])

  // The full picture fades in once it has decoded.
  useEffect(() => {
    if (shot === undefined) return
    let current = true
    const loader = new Image()
    void preferredFormat().then(format => {
      loader.src = lodUrl(shot.id, 3, format)
      return loader.decode()
    }).then(() => { if (current) setReady(shot.id) }, (error: unknown) => {
      // The smaller copy stays on show; the dialog never empties.
      console.warn('The enlarged picture could not load', shot.id, error)
    })
    return () => { current = false }
  }, [shot])

  const close = useCallback(() => {
    const d = dialog.current
    const img = picture.current
    if (d === null || img === null || shot === undefined || closing.current) return
    closing.current = true
    const mine = generation.current
    const tile = (source.current?.dataset['shot'] === shot.id ? source.current : document.querySelector<HTMLElement>(`[data-shot="${shot.id}"]`)) ?? source.current
    const from = tile?.getBoundingClientRect()
    const to = openRect(shot)
    const finish = () => {
      // A press while closing has opened the lightbox again; this close is over.
      if (generation.current !== mine) return
      d.close()
      for (const animation of [...d.getAnimations(), ...img.getAnimations()]) animation.cancel()
      setIndex(undefined)
      tile?.focus({ preventScroll: true })
    }
    if (from === undefined || still() || pans(shot) || from.bottom < 0 || from.top > innerHeight || from.right < 0 || from.left > innerWidth) {
      d.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MS.quick, easing: EASE }).onfinish = finish
      return
    }
    img.animate([{ transform: 'none' }, { transform: fromTransform(from, to) }], { duration: MS.move, easing: EASE, fill: 'forwards' })
    d.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MS.move, easing: EASE, fill: 'forwards' }).onfinish = finish
  }, [shot])

  const step = useCallback((by: number) => {
    // A step while the close runs would change the picture under a lightbox that is about to shut.
    if (closing.current) return
    setPlaceholder(undefined)
    setIndex(at => at === undefined ? at : (at + by + SHOTS.length) % SHOTS.length)
  }, [])

  // Keep the picture placed for the new shot when stepping.
  useEffect(() => {
    if (shot === undefined || picture.current === null || dialog.current?.open !== true) return
    const to = openRect(shot)
    Object.assign(picture.current.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` })
    if (pans(shot) && strip.current !== null) strip.current.scrollLeft = (to.width - innerWidth) * 0.45
  }, [shot])

  // A resize or a turn of the phone while open re-places the picture.
  useEffect(() => {
    if (shot === undefined) return
    const place = () => {
      if (picture.current === null || dialog.current?.open !== true) return
      const to = openRect(shot)
      Object.assign(picture.current.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` })
    }
    addEventListener('resize', place)
    return () => removeEventListener('resize', place)
  }, [shot])

  const drag = useRef<{ x: number; y: number; t: number } | undefined>(undefined)
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return
    drag.current = { x: event.clientX, y: event.clientY, t: performance.now() }
  }
  const onPointerMove = (event: PointerEvent) => {
    if (drag.current === undefined || picture.current === null) return
    const dy = event.clientY - drag.current.y
    const dx = event.clientX - drag.current.x
    if (Math.abs(dy) > Math.abs(dx)) picture.current.style.transform = `translateY(${Math.max(dy, -dy / 4)}px)`
  }
  const onPointerUp = (event: PointerEvent) => {
    const start = drag.current
    drag.current = undefined
    if (start === undefined || picture.current === null) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    const speed = Math.hypot(dx, dy) / Math.max(1, performance.now() - start.t)
    picture.current.style.transform = ''
    if (Math.abs(dy) > Math.abs(dx) && (dy > 90 || (dy > 20 && speed > 0.5))) close()
    else if (shot !== undefined && !pans(shot) && (Math.abs(dx) > 60 || (Math.abs(dx) > 20 && speed > 0.5))) step(dx < 0 ? 1 : -1)
  }

  const value = useMemo(() => open, [open])
  return (
    <LightboxContext.Provider value={value}>
      {children}
      <dialog
        ref={dialog}
        className={s.lightbox}
        aria-label={shot?.caption ?? 'Screenshot'}
        onCancel={event => { event.preventDefault(); close() }}
        onClick={event => { if (event.target === event.currentTarget) close() }}
        onKeyDown={event => {
          if (event.key === 'ArrowRight') step(1)
          if (event.key === 'ArrowLeft') step(-1)
        }}
      >
        {shot === undefined ? null : (
          <>
            <div ref={strip} className={pans(shot) ? s.lightboxPan : undefined} style={pans(shot) ? { bottom: reserve() } : undefined}>
            <div
              ref={picture}
              className={s.lightboxImage}
              data-device={shot.device}
              style={{ background: SHOT_COLOURS[shot.id]?.hex }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => { drag.current = undefined; if (picture.current !== null) picture.current.style.transform = '' }}
            >
              <img key={`small-${shot.id}`} className={s.lightboxLayer} src={placeholder ?? lodUrl(shot.id, 2, currentFormat())} alt="" draggable={false} />
              <img key={`full-${shot.id}`} className={s.lightboxLayer} data-full="" data-ready={ready === shot.id || undefined} src={lodUrl(shot.id, 3, currentFormat())} alt={shot.caption} draggable={false} />
            </div>
            </div>
          <div className={s.plateBar}>
            <div className={s.plate}>
              <div className={s.plateTop}>
                <span className={s.plateNumber}>No. {String((index ?? 0) + 1).padStart(2, '0')} / {SHOTS.length}</span>
                <span className={s.plateButtons}>
                  <button type="button" className={s.lightboxButton} data-paper="" onClick={() => step(-1)} aria-label="Previous screenshot">←</button>
                  <button type="button" className={s.lightboxButton} data-paper="" onClick={() => step(1)} aria-label="Next screenshot">→</button>
                  <button type="button" className={s.lightboxButton} data-paper="" onClick={close} aria-label="Close" autoFocus>✕</button>
                </span>
              </div>
              <p className={s.plateTitle}>{shot.caption}</p>
              <dl className={s.plateFacts}>
                {facts(shot).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
              </dl>
              <p className={s.plateCredit}>{CREDIT}{pans(shot) ? ' Swipe sideways to see the whole screen.' : ''}</p>
            </div>
          </div>
          </>
        )}
      </dialog>
    </LightboxContext.Provider>
  )
}
