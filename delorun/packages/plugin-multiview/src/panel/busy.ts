/**
 * When Multiview must not rearrange by itself: while the pointer is down in the layout (a drag of a pane or a divider, a text
 * selection; until it is released, its capture is lost, the window loses focus, or ten seconds pass) or while the person is typing
 * in a pane. Typing counts from a key that writes text in a text field until a short
 * pause; a focused field the person is not typing in does not hold the layout, and neither does a key chord with Ctrl, Alt or
 * Meta, so the layout keys still act at once.
 * @module @delorun/plugin-multiview/panel/busy
 */

import { useEffect, useState, type RefObject } from 'react'

/** How long after the last key typed in a text field the layout stays held, in milliseconds. */
export const TYPING_HOLD_MS = 1500

/**
 * The longest a pointer held down holds the layout, in milliseconds: a release the page never hears (the pointer let go outside
 * the window, a capture taken away) must not freeze the layout.
 */
export const POINTER_HOLD_MS = 10_000

/**
 * Report whether an element takes typed text.
 * @param element - the event's target.
 * @returns true for a text input, a text area or an editable element.
 */
export function isTextField(element: EventTarget | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(element.type) // us-spelling: quoted output (HTML input types)
  return false
}

/**
 * Watch an element for the person being in the middle of something.
 * @param root - the layout's root element.
 * @returns true while the pointer is down inside it or the person is typing in it.
 */
export function useBusy(root: RefObject<HTMLElement | null>): boolean {
  const [pointer, setPointer] = useState(false)
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    const element = root.current
    if (element === null) return undefined
    const document = element.ownerDocument
    const view = document.defaultView
    let timer: ReturnType<typeof setTimeout> | undefined
    let pointerTimer: ReturnType<typeof setTimeout> | undefined
    const onUp = (): void => {
      if (pointerTimer !== undefined) clearTimeout(pointerTimer)
      pointerTimer = undefined
      setPointer(false)
    }
    const onDown = (): void => {
      setPointer(true)
      if (pointerTimer !== undefined) clearTimeout(pointerTimer)
      pointerTimer = setTimeout(onUp, POINTER_HOLD_MS)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || !isTextField(event.target)) return
      setTyping(true)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; setTyping(false) }, TYPING_HOLD_MS)
    }
    const onBlur = (event: FocusEvent): void => {
      if (!isTextField(event.target)) return
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      setTyping(false)
    }
    element.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onUp, true)
    document.addEventListener('lostpointercapture', onUp, true)
    view?.addEventListener('blur', onUp)
    element.addEventListener('keydown', onKey, true)
    element.addEventListener('focusout', onBlur, true)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      if (pointerTimer !== undefined) clearTimeout(pointerTimer)
      element.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', onUp, true)
      document.removeEventListener('lostpointercapture', onUp, true)
      view?.removeEventListener('blur', onUp)
      element.removeEventListener('keydown', onKey, true)
      element.removeEventListener('focusout', onBlur, true)
    }
  }, [root])
  return pointer || typing
}

/**
 * Hold a value: a new value is taken after it has stayed the same for `delayMs` and only while not `busy`; once busy ends the
 * latest value is taken after the same delay. The first value, and the first defined one, are taken at once.
 * @param value - the value now.
 * @param delayMs - how long a value must stay before it is taken.
 * @param busy - while true no new value is taken.
 * @param same - whether two values are the same, so an equal new value restarts nothing.
 * @returns the value taken.
 */
export function useHeld<T>(value: T, delayMs: number, busy: boolean, same: (left: T, right: T) => boolean = Object.is): T {
  const [held, setHeld] = useState(value)
  // The first defined value (the first measured area) is taken at once, so the first layout is already the right one.
  const first = held === undefined && value !== undefined
  useEffect(() => {
    if (first) {
      setHeld(value)
      return undefined
    }
    if (busy || same(held, value)) return undefined
    const timer = setTimeout(() => { setHeld(value) }, delayMs)
    return () => { clearTimeout(timer) }
  }, [value, delayMs, busy, held, same, first])
  return first ? value : held
}
