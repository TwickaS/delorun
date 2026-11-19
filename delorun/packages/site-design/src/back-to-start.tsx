/**
 * The way back to how the page started: a line that names the look the page is in and the button that returns it. Both
 * appear only once scripts run and a look has been chosen, so a page that is as it started offers nothing to undo.
 *
 * @module @delorun/site-design/back-to-start
 */
import { useEffect, useState } from 'react'
import { Button } from '../../brand/src/components/Button.tsx'
import { useLook, resetLook } from './look-store.ts'
import { announceReset } from './look-toast.tsx'
import { DEFAULT_LOOK, type Look } from './looks.ts'
import type { ThemeCopy } from './shell-copy.ts'

/**
 * Whether the page has scripts running; false during server rendering and until the first effect.
 * @returns true once the component has mounted.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}

/**
 * Whether a look differs from how the page started: another theme, accent, density or contrast, or a chosen scheme.
 * @param look - the page's look.
 * @returns true when there is something to go back to.
 */
export function isChanged(look: Look): boolean {
  return look.look !== DEFAULT_LOOK.look || look.accent !== DEFAULT_LOOK.accent || look.density !== DEFAULT_LOOK.density || look.contrast !== DEFAULT_LOOK.contrast || look.scheme !== undefined
}

/**
 * The line and the button.
 * @param props.copy - the theme control's text; its toast follows the reset.
 * @param props.className - extra classes.
 * @param props.after - the element to focus once the page is reset, since the button is then gone and a keyboard user would be dropped.
 * @returns the line and the button, or nothing before scripts run and while the page is as it started.
 */
export function BackToStart({ copy, className, after }: { copy: ThemeCopy; className?: string | undefined; after?: (() => HTMLElement | null | undefined) | undefined }) {
  const mounted = useMounted()
  const look = useLook()
  if (!mounted || !isChanged(look)) return null
  const scheme = look.scheme === undefined ? undefined : look.scheme === 'dark' ? copy.dark : copy.light
  return (
    <div className={className}>
      <p>{copy.current(copy.names[look.look], scheme)}</p>
      <Button variant="ghost" size="sm" onClick={() => { resetLook(); announceReset(copy); requestAnimationFrame(() => { after?.()?.focus() }) }}>{copy.back}</Button>
    </div>
  )
}
