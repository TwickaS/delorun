/**
 * The toast that follows a change of look: what changed, and the way back by name. The toaster and Sonner load on the
 * first change, not with the page; the toast waits for them. There is one toast at a time.
 *
 * @module @delorun/site-design/look-toast
 */
import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react'
import type { ToastMessage } from '../../brand/src/toast.web.tsx'
import { setLook } from './look-store.ts'
import type { Look } from './looks.ts'
import type { ThemeCopy } from './shell-copy.ts'

/**
 * What a change of look says. A new theme names the theme and offers the earlier one; a switch between light and dark
 * names the scheme.
 * @param copy - the theme control's text.
 * @param previous - the look before.
 * @param next - the look after.
 * @returns the toast, or undefined when neither the theme nor the scheme changed.
 */
export function lookToast(copy: ThemeCopy, previous: Look, next: Look): ToastMessage | undefined {
  const scheme = (look: Look): string => look.scheme === 'dark' ? copy.dark : look.scheme === 'light' ? copy.light : copy.device
  if (previous.look !== next.look) return { message: copy.toast.theme(copy.names[next.look]), action: { label: copy.toast.undo(copy.names[previous.look]), onClick: () => setLook(previous) } }
  if (previous.scheme !== next.scheme) return { message: copy.toast.scheme(scheme(next)), action: { label: copy.toast.undo(scheme(previous)), onClick: () => setLook(previous) } }
  return undefined
}

/** The toast waiting for the toaster, and a counter that tells the toaster component to deliver it. */
let pending: ToastMessage | undefined
let delivery = 0
const listeners = new Set<() => void>()

function request(message: ToastMessage): void {
  pending = message
  delivery++
  for (const listener of listeners) listener()
}

/**
 * Says what a change did.
 * @param copy - the theme control's text.
 * @param previous - the look before.
 * @param next - the look after.
 */
export function announceLook(copy: ThemeCopy, previous: Look, next: Look): void {
  const message = lookToast(copy, previous, next)
  if (message !== undefined) request(message)
}

/**
 * Says the page is back to how it started. The sentence has no action, since it is itself the way back.
 * @param copy - the theme control's text.
 */
export function announceReset(copy: ThemeCopy): void {
  request({ message: copy.toast.reset })
}

const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** The toaster and the code that shows a toast, loaded on first use. */
const Loaded = lazy(async () => {
  const { showToast, Toaster } = await import('../../brand/src/toast.web.tsx')
  return {
    default: function LoadedToaster({ label, delivered }: { label: string; delivered: number }) {
      useEffect(() => {
        if (pending === undefined) return
        showToast(pending)
        pending = undefined
      }, [delivered])
      return <Toaster label={label} />
    },
  }
})

/**
 * The toaster; mount it once at the end of the page. It renders nothing until the first toast is asked for.
 * @param props.copy - the theme control's text.
 * @returns the toaster, or nothing.
 */
export function LookToaster({ copy }: { copy: ThemeCopy }) {
  const delivered = useSyncExternalStore(subscribe, () => delivery, () => 0)
  if (delivered === 0) return null
  return <Suspense fallback={null}><Loaded label={copy.toast.region} delivered={delivered} /></Suspense>
}
