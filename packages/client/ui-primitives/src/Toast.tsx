import { Fragment, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconCheckCircleOutlineRegular } from './icons/index.tsx'
import css from './Toast.module.css'

/** Full-opacity hold before the fade starts, when the owner names none. */
const HOLD_MS = 3000
/** Fade duration. Must agree with the stylesheet's toast-fade duration. */
const FADE_MS = 1000

/** The most toasts shown at once; older ones stay mounted, hidden, and finish their own timers. */
export const MAX_VISIBLE_TOASTS = 3

/** Marks the toast area, so a later toast finds the one element. */
const TOAST_AREA_ATTRIBUTE = 'data-toast-area'

/** Mounted toasts, oldest first. */
let mounted: readonly string[] = []
const listeners = new Set<() => void>()

/**
 * Add a toast to the stack, or take it off.
 * @param id - the toast's id.
 * @param present - whether it is on screen now.
 */
function track(id: string, present: boolean): void {
  mounted = present ? [...mounted, id] : mounted.filter(item => item !== id)
  for (const listener of listeners) listener()
}

/**
 * The one element every toast renders into, created on first use.
 * @returns the area, a child of the body.
 */
function toastArea(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`[${TOAST_AREA_ATTRIBUTE}]`)
  if (existing !== null) return existing
  const area = document.createElement('div')
  area.setAttribute(TOAST_AREA_ATTRIBUTE, '')
  area.className = css.area ?? ''
  document.body.appendChild(area)
  return area
}

/**
 * Transient banner in the one toast area: slides in, holds at full opacity, fades out,
 * then reports done so the owner can unmount it. Re-showing the same text
 * restarts the cycle when the owner remounts the component (key it by a
 * per-show sequence). The area sits bottom left by default, the newest toast at
 * the bottom with older ones pushed up and at most {@link MAX_VISIBLE_TOASTS} visible; the person's
 * `data-toast-position` attribute on the root element (`top-left`, `top-centre`, `top-right`, `bottom-left`,
 * `bottom-centre` or `bottom-right`) moves it, and a phone width pins it to the top, full width.
 * Rendered through a body portal so an owner inside a
 * transformed or filtered ancestor cannot trap the banner in that
 * ancestor's box.
 * With unchanged holdMs, parent rerenders do not extend the lifetime.
 * Completion calls the latest onDone handler; fully faded actions receive no input.
 *
 * The hold is the owner's to set, because how long a banner has to stay
 * depends on how much there is to read: a one-line limit lands in the default
 * window, while a failure that names what broke does not. One value drives
 * both the unmount timer and the stylesheet's fade delay — the stylesheet
 * reads it as a custom property — so the two can no longer disagree and leave
 * the banner unmounting mid-fade.
 * @param props.text - resolved banner copy; the owner passes localized text.
 * @param props.icon - optional leading glyph (e.g. a warning icon); ignored
 * under `tone="success"`, which brings its own glyph.
 * @param props.tone - 'success' renders the design's circled green check as
 * the leading glyph; omitted, the icon seat keeps its warning tint.
 * @param props.actions - optional inline actions continuing the sentence:
 * each renders its plain-text `prefix` (a connective like 或) followed by its
 * localized `label` as blue clickable text, flowing after `text` as one
 * sentence. Each press is the owner's to handle (e.g. undo the reported
 * change, then unmount the toast). The banner surface stays click-through —
 * only the action text takes the pointer.
 * @param props.holdMs - full-opacity hold before the fade; defaults to 3000.
 * @param props.onDone - called once the fade completes; unmount the toast here.
 * @returns the floating banner.
 */
export function Toast({ text, icon, tone, holdMs = HOLD_MS, actions, onDone }: {
  text: string
  icon?: ReactNode
  tone?: 'success'
  holdMs?: number
  actions?: readonly { label: string; prefix?: string; onClick: () => void }[]
  onDone: () => void
}) {
  const latestOnDone = useRef(onDone)
  useLayoutEffect(() => { latestOnDone.current = onDone }, [onDone])
  useEffect(() => {
    const timer = setTimeout(() => { latestOnDone.current() }, holdMs + FADE_MS)
    return () => { clearTimeout(timer) }
  }, [holdMs])
  const id = useId()
  useLayoutEffect(() => {
    track(id, true)
    return () => { track(id, false) }
  }, [id])
  const newest = useSyncExternalStore(subscribe, () => mounted.indexOf(id) - mounted.length)
  const hidden = newest < -MAX_VISIBLE_TOASTS
  return createPortal(
    <div
      className={css.toast}
      role="alert"
      hidden={hidden}
      style={{ '--dsh-toast-hold': `${String(holdMs)}ms` } as CSSProperties}
    >
      {tone === 'success'
        ? <span className={`${css.icon} ${css.success}`} aria-hidden><IconCheckCircleOutlineRegular /></span>
        : icon !== undefined && <span className={css.icon} aria-hidden>{icon}</span>}
      <span className={css.text}>
        {text}
        {actions?.map(action => (
          <Fragment key={action.label}>
            {action.prefix}
            <button type="button" className={css.action} onClick={action.onClick}>
              {action.label}
            </button>
          </Fragment>
        ))}
      </span>
    </div>,
    toastArea(),
  )
}

/**
 * Follow the toast stack.
 * @param listener - called after each change.
 * @returns the unsubscriber.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * A persistent card in the toast area, for a plugin card that stays until the person acts (a download, an update in
 * progress) and so must not place itself on the screen: it sits in the same stack as the toasts, takes the same
 * position setting, and is never hidden by the {@link MAX_VISIBLE_TOASTS} limit. Unlike a toast it takes the pointer.
 * @param props.width - the card's width in pixels on a screen wider than a phone; a phone gives it the full width.
 * @param props.children - the card.
 * @returns the card, in a body portal.
 */
export function ToastSlot({ width, children }: { width: number; children: ReactNode }) {
  return createPortal(
    <div className={css.slot} style={{ '--dsh-slot-width': `${String(width)}px` } as CSSProperties}>{children}</div>,
    toastArea(),
  )
}
