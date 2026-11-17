/**
 * The theme control in the header: a button that opens a menu with the themes, light or dark, and the way back to how the
 * page started. It is drawn only once scripts run, since without them nothing could change. The menu is the browser's
 * native popover, so Escape, a click outside and focus return come from the browser.
 *
 * @module @delorun/site-design/theme-control
 */
import { useEffect, useId, useState } from 'react'
import { Button, ChoiceGroup, ThemePicker } from '../../brand/src/index.ts'
import { LOOK_SWATCHES } from './look-swatches.ts'
import { getLook, resetLook, setLook, useLook } from './look-store.ts'
import { KNOWN_LOOKS, type Look, type LookId } from './looks.ts'
import type { ThemeCopy } from './shell-copy.ts'

/** The themes the menu offers; Custom is the setup strip's. */
const PRESETS = KNOWN_LOOKS.filter((id): id is Exclude<LookId, 'custom'> => id !== 'custom')

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
 * @param props.label - its text.
 * @param props.onReset - called after the page is reset, with the look before and after.
 * @param props.className - extra classes.
 * @returns the button, or nothing before scripts run.
 */
export function BackToStart({ label, onReset, className }: { label: string; onReset?: ((previous: Look, next: Look) => void) | undefined; className?: string | undefined }) {
  const mounted = useMounted()
  if (!mounted) return null
  return <Button variant="ghost" size="sm" className={className} onClick={() => { const previous = getLook(); resetLook(); onReset?.(previous, getLook()) }}>{label}</Button>
}

/**
 * The theme control.
 * @param props.copy - its text.
 * @param props.onChange - called with the look before and after a change the visitor makes, for the toast.
 * @returns the control, or nothing before scripts run.
 */
export function ThemeControl({ copy, onChange }: { copy: ThemeCopy; onChange?: ((previous: Look, next: Look) => void) | undefined }) {
  const look = useLook()
  const mounted = useMounted()
  const menu = useId()
  if (!mounted) return null
  const change = (next: Look): void => {
    setLook(next)
    onChange?.(look, next)
  }
  return (
    <>
      <button type="button" popoverTarget={menu} aria-label={copy.open}
        className="flex size-9 items-center justify-center rounded-(--dl-radius-sm) border border-(--dl-border) bg-(--dl-surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--dl-accent-text) active:scale-[0.97]">
        <span aria-hidden="true" className="size-4 rounded-full bg-(--dl-accent)" />
      </button>
      <div id={menu} popover="auto" role="dialog" aria-label={copy.title}
        className="fixed top-16 right-4 bottom-auto left-auto m-0 w-[min(22rem,calc(100vw-2rem))] rounded-(--dl-radius-md) border border-(--dl-border) bg-(--dl-surface-raised) p-4 text-(--dl-text) shadow-lg">
        <div className="flex flex-col gap-4">
          <ThemePicker label={copy.themes} value={look.look === 'custom' ? 'soft' : look.look}
            themes={PRESETS.map(id => ({ value: id, label: copy.names[id], ...LOOK_SWATCHES[id]! }))}
            onChange={id => change({ ...look, look: id, contrast: 'default' })} />
          <ChoiceGroup label={copy.scheme} value={look.scheme ?? 'light'} disabled={false} fill
            options={[{ value: 'light', label: copy.light }, { value: 'dark', label: copy.dark }]}
            onChange={scheme => change({ ...look, scheme })} />
          <BackToStart label={copy.back} onReset={onChange} className="self-start" />
        </div>
      </div>
    </>
  )
}
