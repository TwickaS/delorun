/**
 * The theme control in the header: a button that opens a menu with the themes, light or dark, and the way back to how the
 * page started. It is drawn only once scripts run, since without them nothing could change. The menu is the browser's
 * native popover, so Escape, a click outside and focus return come from the browser.
 *
 * @module @delorun/site-design/theme-control
 */
import { lazy, Suspense, useCallback, useId, useRef, useState, type ToggleEvent } from 'react'
import { useMounted } from './back-to-start.tsx'
import { useLook } from './look-store.ts'
import type { ThemeCopy } from './shell-copy.ts'

/** The menu's contents, loaded the first time the menu opens. */
const ThemeMenu = lazy(() => import('./theme-menu.tsx'))

/** The button that opens the menu. */
const TRIGGER = 'flex size-11 items-center justify-center rounded-(--dl-radius-sm) border border-(--dl-border) bg-(--dl-surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--dl-text) active:scale-[0.97]' // us-spelling: quoted output (Tailwind class names)

/** The button in the row variant: an icon and the current theme's name, as high as a normal control. */
const ROW_TRIGGER = 'flex h-9 max-w-40 shrink-0 items-center gap-2 rounded-(--dl-radius-sm) border border-(--dl-border) bg-(--dl-surface) px-2.5 text-sm text-(--dl-text-muted) hover:text-(--dl-text) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--dl-text) active:scale-[0.97]' // us-spelling: quoted output (Tailwind class names)

/** The control's place before scripts run: the button's size. */
const RESERVED = 'block size-11 shrink-0'

/** The row variant's place before scripts run. */
const ROW_RESERVED = 'block h-9 w-24 shrink-0'

/** How the control's button looks: the theme's colour dot, or the light or dark icon with the theme's name. */
export type ThemeControlVariant = 'dot' | 'row'

/**
 * The icon of the page's colour scheme: a sun in light, a moon in dark.
 * @param props.dark - whether the page is dark.
 * @returns the icon, drawn in the text colour.
 */
function SchemeIcon({ dark }: { dark: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {dark
        ? <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
    </svg>
  )
}

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
 * @param props.variant - `dot` (the default) shows a colour dot; `row` shows the light or dark icon and the current theme's name, for a place with room such as a sidebar's footer.
 * @returns the control, or nothing before scripts run.
 */
export function ThemeControl({ copy, variant = 'dot' }: { copy: ThemeCopy; variant?: ThemeControlVariant }) {
  const mounted = useMounted()
  const look = useLook()
  const menu = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [opened, setOpened] = useState(false)
  const place = useCallback(() => { if (button.current !== null && panel.current !== null) placeMenu(button.current, panel.current) }, [])
  // Until scripts run the control's place is kept, so the header does not grow when the button arrives.
  if (!mounted) return <span aria-hidden="true" className={variant === 'row' ? ROW_RESERVED : RESERVED} />
  const dark = document.documentElement.classList.contains('dark')
  const name = copy.names[look.look]
  // The row's name says which theme and which scheme the page is in; the visible name is part of it.
  const scheme = dark ? copy.dark : copy.light
  const described = copy.trigger?.(name, scheme) ?? `${copy.title}: ${name}, ${scheme.toLowerCase()}`
  return (
    <>
      {variant === 'row'
        ? (
            <button type="button" ref={button} popoverTarget={menu} aria-label={described} title={described} data-theme-trigger="row" className={ROW_TRIGGER}>
              <SchemeIcon dark={dark} />
              <span className="truncate">{name}</span>
            </button>
          )
        : (
            <button type="button" ref={button} popoverTarget={menu} aria-label={copy.open} className={TRIGGER}>
              <span aria-hidden="true" className="size-4 rounded-full bg-(--dl-accent)" />
            </button>
          )}
      <div id={menu} ref={panel} popover="auto" role="dialog" aria-label={copy.title}
        onToggle={(event: ToggleEvent<HTMLDivElement>) => { if (event.newState === 'open') { setOpened(true); place() } }}
        className="look-menu fixed inset-auto m-0 w-[min(22rem,calc(100vw-2rem))] rounded-(--dl-radius-md) border border-(--dl-border) bg-(--dl-surface-raised) p-4 text-(--dl-text) shadow-lg">
        {opened ? <Suspense fallback={null}><ThemeMenu copy={copy} onReady={place} /></Suspense> : null}
      </div>
    </>
  )
}
