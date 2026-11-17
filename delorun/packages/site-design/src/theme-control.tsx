/**
 * The theme control in the header: a button that opens a menu with the themes, light or dark, and the way back to how the
 * page started. It is drawn only once scripts run, since without them nothing could change. The menu is the browser's
 * native popover, so Escape, a click outside and focus return come from the browser.
 *
 * @module @delorun/site-design/theme-control
 */
import { lazy, Suspense, useCallback, useId, useRef, useState, type ToggleEvent } from 'react'
import { useMounted } from './back-to-start.tsx'
import type { ThemeCopy } from './shell-copy.ts'

/** The menu's contents, loaded the first time the menu opens. */
const ThemeMenu = lazy(() => import('./theme-menu.tsx'))

/** The button that opens the menu. */
const TRIGGER = 'flex size-11 items-center justify-center rounded-(--dl-radius-sm) border border-(--dl-border) bg-(--dl-surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--dl-accent-text) active:scale-[0.97]' // us-spelling: quoted output (Tailwind class names)

/** The gap between the button and its menu, and the margin kept to the window's edge, in pixels. */
const GAP = 8

/**
 * Places a menu beside its button: below it when there is room and above it otherwise, its right edge on the button's
 * and kept inside the window; the transform origin is the button's corner, so the menu opens from there.
 * @param button - the trigger.
 * @param menu - the open popover.
 */
export function placeMenu(button: HTMLElement, menu: HTMLElement): void {
  const anchor = button.getBoundingClientRect()
  const { offsetWidth: width, offsetHeight: height } = menu
  const left = Math.max(GAP, Math.min(anchor.right - width, window.innerWidth - width - GAP))
  const below = anchor.bottom + GAP + height <= window.innerHeight - GAP
  const top = below ? anchor.bottom + GAP : Math.max(GAP, anchor.top - GAP - height)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.transformOrigin = `${Math.round(anchor.left + anchor.width / 2 - left)}px ${below ? 'top' : 'bottom'}`
}

/**
 * The theme control.
 * @param props.copy - its text.
 * @returns the control, or nothing before scripts run.
 */
export function ThemeControl({ copy }: { copy: ThemeCopy }) {
  const mounted = useMounted()
  const menu = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [opened, setOpened] = useState(false)
  const place = useCallback(() => { if (button.current !== null && panel.current !== null) placeMenu(button.current, panel.current) }, [])
  if (!mounted) return null
  return (
    <>
      <button type="button" ref={button} popoverTarget={menu} aria-label={copy.open} className={TRIGGER}>
        <span aria-hidden="true" className="size-4 rounded-full bg-(--dl-accent)" />
      </button>
      <div id={menu} ref={panel} popover="auto" role="dialog" aria-label={copy.title}
        onToggle={(event: ToggleEvent<HTMLDivElement>) => { if (event.newState === 'open') { setOpened(true); place() } }}
        className="look-menu fixed inset-auto m-0 w-[min(22rem,calc(100vw-2rem))] rounded-(--dl-radius-md) border border-(--dl-border) bg-(--dl-surface-raised) p-4 text-(--dl-text) shadow-lg">
        {opened ? <Suspense fallback={null}><ThemeMenu copy={copy} onReady={place} /></Suspense> : null}
      </div>
    </>
  )
}
