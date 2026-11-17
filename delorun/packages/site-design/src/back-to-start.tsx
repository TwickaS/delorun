/**
 * The button that returns the page to how it started, and the hook that tells components scripts are running.
 *
 * @module @delorun/site-design/back-to-start
 */
import { useEffect, useState } from 'react'
import { Button } from '../../brand/src/components/Button.tsx'
import { resetLook } from './look-store.ts'
import { announceReset } from './look-toast.tsx'
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
 * The button that returns the page to how it started.
 * @param props.copy - the theme control's text; its toast follows the reset.
 * @param props.className - extra classes.
 * @returns the button, or nothing before scripts run.
 */
export function BackToStart({ copy, className }: { copy: ThemeCopy; className?: string | undefined }) {
  const mounted = useMounted()
  if (!mounted) return null
  return <Button variant="ghost" size="sm" className={className} onClick={() => { resetLook(); announceReset(copy) }}>{copy.back}</Button>
}
