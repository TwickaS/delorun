/**
 * The header's theme control and the effects readout. Each press asks the effects queue for the next look after the
 * last one asked for; the queue plays the changes one at a time, each spreading from the dot in a circle. The pill
 * shows the look the page has now. The readout beside it shows what runs and what waits; on a phone it shrinks to a dot
 * and a count. While a look change runs, Chrome sends presses to the root element rather than to the control, so a click
 * on the root inside the control's box counts as a press too. Nothing is stored.
 *
 * @module @delorun/website/home/theme-dot
 */
import { useEffect, useRef } from 'react'
import { getLook, setLook, useLook } from '@design/look-store.ts'
import { KNOWN_LOOKS, lookName, type LookId } from '@design/looks.ts'
import { enqueue, lastQueued, useEffects, type EffectRun } from './effects.ts'
import { canRetile, retile } from './retile.ts'
import s from './home.module.css'

/** The looks the dot steps through, in order. */
const CYCLE: readonly LookId[] = KNOWN_LOOKS.filter(id => id !== 'custom')

/** How long one look change spreads at normal speed, in milliseconds. */
const SPREAD = 700

/** A document that may offer view transitions. */
type TransitionDocument = Document & { startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void>; skipTransition: () => void } }

/** The running look change's view transition, if one runs. */
let active: { readonly finished: Promise<void>; skipTransition: () => void } | undefined

/**
 * Changes the look, spreading the new one from a point in a circle.
 * @param look - the look to apply.
 * @param from - the element the circle grows from.
 * @param run - the queue's controls for this effect.
 * @returns a promise that settles when the change has finished.
 */
async function spread(look: LookId, from: HTMLElement | null, run: EffectRun): Promise<void> {
  const apply = () => setLook({ ...getLook(), look })
  const doc = document as TransitionDocument
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const rect = from?.getBoundingClientRect()
  if (doc.startViewTransition === undefined || rect === undefined) {
    apply()
    return
  }
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  const transition = doc.startViewTransition(apply)
  active = transition
  void transition.finished.then(() => { if (active === transition) active = undefined })
  await transition.ready
  run.track(document.documentElement.animate(
    still ? { opacity: [0, 1] } : { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
    { duration: still ? 200 : SPREAD, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', pseudoElement: '::view-transition-new(root)' },
  ))
  await transition.finished
}

/**
 * The theme control.
 * @returns the button.
 */
export function ThemeDot() {
  const dot = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const look = useLook()

  const press = () => {
    const from = (lastQueued()?.value as LookId | undefined) ?? getLook().look
    const next = CYCLE[(CYCLE.indexOf(from) + 1) % CYCLE.length] ?? 'soft'
    const name = lookName(next)
    // On a page with a mosaic, the mark re-tiles in the new look while the look spreads from the control.
    const tiles = canRetile()
    enqueue({
      label: tiles ? `theme → ${name} · retiling` : `theme → ${name}`,
      done: `✓ ${name}`,
      value: next,
      run: async run => { await Promise.all([spread(next, dot.current, run), tiles ? retile(next, run) : undefined]) },
    })
  }
  const pressed = useRef(press)
  pressed.current = press

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const rect = button.current?.getBoundingClientRect()
      if (event.target !== document.documentElement || rect === undefined) return
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        pressed.current()
        return
      }
      // Anywhere else, the press was meant for what sits under the transition: end the transition at once and pass the
      // press on, so a tile pressed during a look change still opens.
      const transition = active
      if (transition === undefined) return
      transition.skipTransition()
      void transition.finished.then(() => {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('button, a, [role="button"]')
        target?.click()
      })
    }
    addEventListener('click', onClick, true)
    return () => removeEventListener('click', onClick, true)
  }, [])

  const name = lookName(look.look)
  return (
    <button ref={button} type="button" className={s.dotWrap} data-theme-control="" onClick={press} aria-label={`Look: ${name}. Press for the next look`}>
      <span className={s.dotName}>{name}</span>
      <span ref={dot} className={s.dot} aria-hidden="true"><span /></span>
    </button>
  )
}

/**
 * The effects readout: what runs and what waits, set like a command line. Screen readers hear only the look the page
 * settles on, not each step.
 * @returns the readout.
 */
export function EffectStatus() {
  const { running, waiting, done } = useEffects()
  const look = useLook()
  const busy = running !== undefined
  const text = running === undefined ? done ?? 'idle' : waiting > 0 ? `${running} · ${waiting} queued` : running
  return (
    <span className={s.status} data-state={busy ? 'busy' : done === undefined ? 'idle' : 'done'}>
      <span className={s.statusLine} aria-hidden="true"><span className={s.statusPrompt}>❯</span> {text}</span>
      <span className={s.srOnly} aria-live="polite">{busy ? '' : `Look: ${lookName(look.look)}`}</span>
    </span>
  )
}
