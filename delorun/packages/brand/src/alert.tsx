/**
 * The studio's alert: a quiet glass card with a status icon in a tinted circle, a title, one muted line, a tinted
 * primary action, a quiet secondary action and an optional close button (A630). One component draws the inline card
 * (sidebar, input dock), the toast and the banner; a dialog uses the same surface through {@link ALERT_CLASSES}.
 *
 * The component holds no copy and no styles of its own: `@delorun/plugin-theme` styles the {@link ALERT_CLASSES} while
 * the Delorun look is on, and its README holds the style note. The role follows the kind unless the caller names one:
 * `alert` for a warning or an error, `status` otherwise. Each kind has its own glyph, so colour is never the only
 * signal.
 * @module @delorun/brand/alert
 */
import { useEffect, useRef, type ReactNode } from 'react'

/** The kinds of alert, each with its own glyph and tint. */
export type AlertKind = 'info' | 'success' | 'warning' | 'error' | 'progress'

/** Where the alert sits: in a column (`inline`), floating (`toast`) or across a pane (`banner`). */
export type AlertVariant = 'inline' | 'toast' | 'banner'

/** An action: its localised label and what it does. */
export interface AlertAction {
  readonly label: string
  readonly onClick: () => void
}

/** The class names `@delorun/plugin-theme` styles; a surface that cannot use {@link Alert} uses them directly. */
export const ALERT_CLASSES = {
  /** The bare glass surface; with `data-variant="dialog"` the dialog size. */
  glass: 'delorun-glass',
  root: 'delorun-alert',
  icon: 'delorun-alert-icon',
  body: 'delorun-alert-body',
  title: 'delorun-alert-title',
  line: 'delorun-alert-line',
  actions: 'delorun-alert-actions',
  /** A dialog's action row: the secondary action first, so it sits left of the primary. */
  dialogActions: 'delorun-alert-dialog-actions',
  primary: 'delorun-alert-primary',
  secondary: 'delorun-alert-secondary',
  close: 'delorun-alert-close',
} as const

/** How long the leave transition runs, in milliseconds; `@delorun/plugin-theme`'s `--delorun-alert-exit` matches it. */
export const ALERT_EXIT_MS = 150

/** The props of {@link Alert}, apart from the `data-*` attributes it passes to its root. */
export interface AlertOwnProps {
  readonly kind: AlertKind
  /** Defaults to `inline`. */
  readonly variant?: AlertVariant
  /** The localised title, in a few words. */
  readonly title: string
  /** One muted line under the title. */
  readonly line?: ReactNode
  /** The tinted action. */
  readonly primary?: AlertAction | undefined
  /** The quiet action beside it. */
  readonly secondary?: AlertAction | undefined
  /** The close button: its localised name and what it does. */
  readonly close?: AlertAction | undefined
  /** Overrides the role the kind gives; `note` marks a standing notice that is not announced as it appears. */
  readonly role?: 'status' | 'alert' | 'note'
  /** Plays the leave transition, then calls `onClosed`. */
  readonly closing?: boolean
  /** Called once the leave transition has finished; unmount the alert here. */
  readonly onClosed?: () => void
  /** Extra classes for placement. */
  readonly className?: string | undefined
  /** A `data-outcome` value, which tests and styles may select. */
  readonly outcome?: string | undefined
}

/** The props of {@link Alert}: its own, and `data-*` attributes for the root, which a surface's tests and styles select. */
export type AlertProps = AlertOwnProps & { readonly [attribute: `data-${string}`]: string | undefined }

/**
 * Render an alert.
 * @param props - see {@link AlertProps}.
 * @returns the alert.
 */
export function Alert({ kind, variant = 'inline', title, line, primary, secondary, close, role, closing = false, onClosed, className, outcome, ...data }: AlertProps) {
  const node = useRef<HTMLDivElement>(null)
  const latestOnClosed = useRef(onClosed)
  latestOnClosed.current = onClosed
  useEffect(() => {
    if (!closing) return undefined
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      latestOnClosed.current?.()
    }
    const element = node.current
    const ended = (event: TransitionEvent): void => { if (event.target === element && event.propertyName === 'opacity') finish() }
    element?.addEventListener('transitionend', ended)
    // Reduced motion runs no transition, and a hidden tab may never fire the event.
    const timer = setTimeout(finish, ALERT_EXIT_MS + 50)
    return () => {
      clearTimeout(timer)
      element?.removeEventListener('transitionend', ended)
    }
  }, [closing])
  const actions = primary !== undefined || secondary !== undefined
  return (
    <div
      {...data}
      ref={node}
      className={className === undefined ? ALERT_CLASSES.root : `${ALERT_CLASSES.root} ${className}`}
      role={role ?? (kind === 'warning' || kind === 'error' ? 'alert' : 'status')}
      data-kind={kind}
      data-variant={variant}
      data-state={closing ? 'closing' : 'open'}
      data-outcome={outcome}
    >
      <span className={ALERT_CLASSES.icon} aria-hidden="true">{GLYPHS[kind]}</span>
      <div className={ALERT_CLASSES.body}>
        <p className={ALERT_CLASSES.title}>{title}</p>
        {line === undefined ? null : <p className={ALERT_CLASSES.line}>{line}</p>}
        {variant === 'banner' || !actions ? null : <AlertActions primary={primary} secondary={secondary} />}
      </div>
      {variant === 'banner' && actions ? <AlertActions primary={primary} secondary={secondary} /> : null}
      {close === undefined
        ? null
        : (
          <button type="button" className={ALERT_CLASSES.close} aria-label={close.label} onClick={close.onClick}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
          </button>
          )}
    </div>
  )
}

/**
 * The action row: the tinted action, then the quiet one.
 * @param props.primary - the tinted action.
 * @param props.secondary - the quiet action.
 * @returns the row.
 */
function AlertActions({ primary, secondary }: { primary: AlertAction | undefined; secondary: AlertAction | undefined }) {
  return (
    <div className={ALERT_CLASSES.actions}>
      {primary === undefined ? null : <button type="button" className={ALERT_CLASSES.primary} onClick={primary.onClick}>{primary.label}</button>}
      {secondary === undefined ? null : <button type="button" className={ALERT_CLASSES.secondary} onClick={secondary.onClick}>{secondary.label}</button>}
    </div>
  )
}

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** One glyph per kind, drawn on a 16-unit grid: i, a tick, !, a cross and an open ring. */
const GLYPHS: Readonly<Record<AlertKind, ReactNode>> = {
  info: <svg viewBox="0 0 16 16" {...STROKE} data-glyph="info"><path d="M8 7.25v4.25" /><path d="M8 4.6v.05" /></svg>,
  success: <svg viewBox="0 0 16 16" {...STROKE} data-glyph="success"><path d="M4.5 8.4l2.3 2.3 4.7-5" /></svg>,
  warning: <svg viewBox="0 0 16 16" {...STROKE} data-glyph="warning"><path d="M8 4.5v4.25" /><path d="M8 11.4v.05" /></svg>,
  error: <svg viewBox="0 0 16 16" {...STROKE} data-glyph="error"><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" /></svg>,
  progress: <svg viewBox="0 0 16 16" {...STROKE} data-glyph="progress"><path d="M8 2.75a5.25 5.25 0 1 1-5.25 5.25" /></svg>,
}
