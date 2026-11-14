/**
 * Reusable brand parts built from the studio's design tokens: a row of progress dots, a round keypad, an in-place
 * notice with an icon, a status card row and a destructive action with an inline confirmation. They hold no product
 * copy; callers pass localized strings.
 */
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './brand-parts.module.css'

/** An icon component of the shared sprite. */
export type PartIcon = ComponentType<SVGProps<SVGSVGElement>>

/**
 * A row of dots, one per entered character, with at least `minimum` empty slots. It carries no entered value, in text or
 * in an attribute, and is hidden from assistive technology.
 * @param props - how many characters are entered, the fewest slots, the tone and whether the row shakes.
 * @returns the dots.
 */
export function DotRow({ count, minimum, tone = 'neutral', shake = false }: { count: number; minimum: number; tone?: 'neutral' | 'error'; shake?: boolean }): ReactNode {
  return <div className={css.dots} aria-hidden="true" data-dots={count} data-tone={tone} data-shake={shake ? '' : undefined}>
    {Array.from({ length: Math.max(minimum, count) }, (_, index) => <span key={index} className={index < count ? `${css.dot} ${css.filled}` : css.dot} />)}
  </div>
}

/** The keypad's keys in reading order; the empty entry is the blank cell beside 0. */
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'] as const

/**
 * A round digit keypad of real buttons, each at least 44px.
 * @param props - the key handler (a digit, or `⌫` for delete), the delete key's name, and whether the keys are disabled.
 * @returns the keypad.
 */
export function Keypad({ onKey, deleteLabel, disabled = false }: { onKey: (key: string) => void; deleteLabel: string; disabled?: boolean }): ReactNode {
  return <div className={css.keypad}>
    {KEYS.map((key, index) => key === ''
      ? <span key={index} />
      : <button key={key} type="button" className={key === '⌫' ? `${css.key} ${css.erase}` : css.key} disabled={disabled}
        aria-label={key === '⌫' ? deleteLabel : key} onClick={() => { onKey(key) }}>{key}</button>)}
  </div>
}

/**
 * An in-place notice: an icon, a bold title, a sentence and optional actions.
 * @param props - the icon, the title, the tone, the live-region role, and the sentence and actions as children.
 * @returns the notice.
 */
export function Notice({ Icon, title, tone = 'warn', role = 'status', outcome, children, actions }: {
  Icon: PartIcon; title: string; tone?: 'warn' | 'error'; role?: 'status' | 'alert'; outcome?: string; children: ReactNode; actions?: ReactNode
}): ReactNode {
  return <div className={css.notice} role={role} data-tone={tone} data-outcome={outcome}>
    <Icon className={css.noticeIcon} aria-hidden="true" />
    <div className={css.noticeText}>
      <strong className={css.noticeTitle}>{title}</strong>
      <span>{children}</span>
      {actions === undefined ? null : <div className={css.noticeActions}>{actions}</div>}
    </div>
  </div>
}

/**
 * A status row: an icon disc, a title with an optional detail line, and a pill.
 * @param props - the icon, whether the state is on, the title, the detail and the pill's text.
 * @returns the row.
 */
export function StatusCard({ Icon, on, title, detail, pill, titleAttribute }: {
  Icon: PartIcon; on: boolean; title: string; detail?: string | undefined; pill: string; titleAttribute?: string
}): ReactNode {
  return <div className={css.status}>
    <span className={css.statusIcon} data-on={on ? '' : undefined} aria-hidden="true"><Icon /></span>
    <div className={css.statusText}>
      <p className={css.statusTitle} data-state={titleAttribute}>{title}</p>
      {detail === undefined ? null : <p className={css.statusDetail}>{detail}</p>}
    </div>
    <Pill active={on}>{pill}</Pill>
  </div>
}

/**
 * A destructive action that asks one inline confirmation before it runs.
 * @param props - whether the confirmation shows, the labels, the group name, and the handlers.
 * @returns the button, or the confirmation.
 */
export function ConfirmAction({ confirming, onAsk, onConfirm, onCancel, label, question, yes, no, disabled, confirmAttribute }: {
  confirming: boolean; onAsk: () => void; onConfirm: () => void; onCancel: () => void
  label: string; question: string; yes: string; no: string; disabled: boolean; confirmAttribute?: string
}): ReactNode {
  if (!confirming) return <div><Button variant="outline" size="sm" className={css.danger} disabled={disabled} onClick={onAsk}>{label}</Button></div>
  return <div className={css.confirm} role="group" aria-label={label} data-confirm={confirmAttribute}>
    <p className={css.confirmText}>{question}</p>
    <div className={css.confirmActions}>
      <Button variant="outline" size="sm" className={css.danger} disabled={disabled} onClick={onConfirm}>{yes}</Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={onCancel}>{no}</Button>
    </div>
  </div>
}
