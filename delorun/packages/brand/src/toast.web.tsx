/**
 * The sites' toast: the brand's look drawn through Sonner's headless form. There is one toast at a time: a new one
 * replaces the one showing. It waits while it has focus or the pointer, or the tab is hidden; its action is a real
 * button, reached by Tab or by Sonner's Alt+T; and it leaves by a swipe down or sideways. The studio has its own toast
 * and does not load Sonner, so this module is the website's and the docs' only and is not exported from the index.
 * @module @delorun/brand/toast
 */
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
export function showToast({ message, action }: ToastMessage): void {
  toast.custom(id => <ToastCard message={message} action={action} onDone={() => { toast.dismiss(id) }} />, { id: ONE_TOAST })
}

/** The props of {@link Toaster}. */
export interface ToasterProps {
  /** The localised name of the toasts' region, such as "Notifications". */
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
  return (
    <SonnerToaster
      position="bottom-center"
      visibleToasts={1}
      duration={holdMs}
      swipeDirections={['bottom', 'left', 'right']}
      containerAriaLabel={label}
      className={css.toaster ?? ''}
      toastOptions={{ unstyled: true, className: css.toast ?? '' }}
    />
  )
}
