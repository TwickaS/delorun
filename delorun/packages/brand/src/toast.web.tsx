/**
 * The sites' toast: the brand's look drawn through Sonner's headless form. There is one toast at a time: a new one
 * replaces the one showing. It waits while it has the pointer or the tab is hidden (Sonner's pause) and while focus is
 * inside it (the {@link Toaster} holds it then); its action is a real button, reached by Tab or by Sonner's Alt+T; and it leaves by a swipe down or sideways. The studio has its own toast
 * and does not load Sonner, so this module is the website's and the docs' only and is not exported from the index.
 * @module @delorun/brand/toast
 */
import type { FocusEvent } from 'react'
import { toast, Toaster as SonnerToaster } from 'sonner'
import { Button } from './components/Button.tsx'
import css from './toast.web.module.css'

/** How long a toast waits before it leaves by itself, in milliseconds, unless the {@link Toaster} names another. */
export const TOAST_HOLD_MS = 6000

/** The one toast's id: showing a toast under the same id replaces the one before. */
const ONE_TOAST = 'delorun-toast'

/** A toast's action: the localised label of the way back, such as "Back to Soft", and what it does. */
export interface ToastAction {
  readonly label: string
  readonly onClick: () => void
}

/** What a toast says: one localised sentence and an optional action. */
export interface ToastMessage {
  readonly message: string
  readonly action?: ToastAction | undefined
}

/** The props of {@link ToastCard}. */
export interface ToastCardProps extends ToastMessage {
  /** Called after the action runs, to close the toast. */
  readonly onDone: () => void
}

/**
 * Draw a toast's card: the sentence and the action. {@link showToast} draws it inside the toaster; a page may draw it
 * alone, as the preview does.
 * @param props - see {@link ToastCardProps}.
 * @returns the card.
 */
export function ToastCard({ message, action, onDone }: ToastCardProps) {
  return (
    <div className={css.card}>
      <p className={css.message}>{message}</p>
      {action === undefined ? null : <Button size="sm" className={css.action} onClick={() => { action.onClick(); onDone() }}>{action.label}</Button>}
    </div>
  )
}

/**
 * Show a toast, replacing the one showing. It does nothing until a {@link Toaster} is mounted, and on the server.
 * @param message - see {@link ToastMessage}.
 */
export function showToast(message: ToastMessage): void {
  shown = message
  draw(message, held ? Infinity : undefined)
}

/** The toast last shown, which the toaster draws again to hold it or let it go. */
let shown: ToastMessage | undefined
/** Whether focus is inside the toaster, which holds the toast until focus leaves. */
let held = false

/** Draw the one toast; `duration` undefined takes the toaster's hold. Sonner updates a toast of the same id in place. */
function draw({ message, action }: ToastMessage, duration: number | undefined): void {
  const render = (id: string | number) => <ToastCard message={message} action={action} onDone={() => { toast.dismiss(id) }} />
  // A toast removed while focus is inside it fires no blur in every browser, so its end also ends the hold.
  const release = () => { held = false }
  const options = { id: ONE_TOAST, onDismiss: release, onAutoClose: release }
  toast.custom(render, duration === undefined ? options : { ...options, duration })
}

/** Whether the one toast is still showing. */
const showing = (): boolean => toast.getToasts().some(item => item.id === ONE_TOAST && !('dismiss' in item && item.dismiss))

/** The props of {@link Toaster}. */
export interface ToasterProps {
  /** The localised name of the toasts' region, such as "Notifications"; it is the region's whole name, so a mention of Alt+T belongs in it. */
  readonly label: string
  /** How long a toast waits before it leaves by itself, in milliseconds; defaults to {@link TOAST_HOLD_MS}. */
  readonly holdMs?: number
}

/**
 * Mount the toaster once per page, at the end of the body's content. It renders on the server as an empty region.
 * @param props - see {@link ToasterProps}.
 * @returns the toaster.
 */
export function Toaster({ label, holdMs = TOAST_HOLD_MS }: ToasterProps) {
  // Sonner pauses its timer for the pointer and Alt+T but not for Tab focus, so a focused toast is redrawn without a
  // time limit, and redrawn with the hold when focus leaves the toaster.
  const hold = (inside: boolean) => {
    if (held === inside) return
    held = inside
    if (shown !== undefined && showing()) draw(shown, inside ? Infinity : holdMs)
  }
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) hold(false)
  }
  return (
    <div className={css.focus} onFocus={() => { hold(true) }} onBlur={leave}>
      <SonnerToaster
        position="bottom-center" // us-spelling: quoted output (Sonner's API value)
        visibleToasts={1}
        duration={holdMs}
        swipeDirections={['bottom', 'left', 'right']}
        customAriaLabel={label}
        className={css.toaster ?? ''}
        toastOptions={{ unstyled: true, className: css.toast ?? '' }}
      />
    </div>
  )
}
