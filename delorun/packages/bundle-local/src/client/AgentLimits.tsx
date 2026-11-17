/**
 * The sign-in line, the limit bars and "Check now" of one external agent, as the agent card, Settings and the Plans
 * pill's popover show them. Showing them reads stored figures only; a check starts only from the button (T12).
 * @module @delorun/bundle-local/client/AgentLimits
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountView, RefreshOutcome } from '@delorun/external-agents/accounts/wire'
import { checkAccount, readAccounts } from './agent-limits-api.ts'
import type { LimitsKey } from './agent-limits-locales.ts'
import { FRESH_MS, lastSeenAt, planName, titleKey, windowTitle, windowViews, type AccountFigures, type WindowView } from './agent-limits.ts'
import { ELEVATION_REQUIRED } from './gate.ts'
import { failureSentence, hostFailureOf, isRefused, type HostFetch } from './host-api.ts'
import css from './AgentLimits.module.css'

export { highestShare, pillStanding, type AccountFigures } from './agent-limits.ts'

/** The copy lookup: a surface's translate function, which holds {@link LimitsKey}'s keys. */
export type LimitsTranslate = (key: LimitsKey, params?: Readonly<Record<string, string>>) => string

/**
 * @param t - the copy.
 * @param at - a time in milliseconds since the epoch.
 * @param now - the time the answer was made.
 * @returns the time on the person's own clock: the hour alone for today, with the date for any other day.
 */
export function clockTime(t: LimitsTranslate, at: number, now: number): string {
  const locale = t('limits.time.locale')
  const same = new Date(at).toDateString() === new Date(now).toDateString()
  return new Intl.DateTimeFormat(locale, same ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
}

/**
 * @param t - the copy.
 * @param kind - a window kind.
 * @returns its title in the person's language where translated, otherwise in words.
 */
function title(t: LimitsTranslate, kind: string): string {
  const key = titleKey(kind)
  return key === undefined ? windowTitle(kind) : t(key.key, key.count === undefined ? undefined : { count: key.count })
}

/**
 * The sign-in line of an agent.
 * @param t - the copy.
 * @param account - the stored figures, or undefined before they are read.
 * @returns the line, or undefined while the store knows nothing and the file hint stands in.
 */
export function signInText(t: LimitsTranslate, account: AccountFigures | undefined): string | undefined {
  if (account === undefined || account.signedIn === 'unknown') return undefined
  if (account.signedIn === 'no') return t('limits.signedOut')
  return account.plan === undefined ? t('limits.signedIn') : t('limits.signedInPlan', { plan: planName(account.plan) })
}

/**
 * One window's bar. The value is text, and "near" and "reached" are words as well as colours.
 * @param props - the window, the time and the copy.
 * @returns the bar.
 */
function Bar({ view, now, t }: { readonly view: WindowView; readonly now: number; readonly t: LimitsTranslate }): ReactNode {
  const name = title(t, view.kind)
  const value = view.percent === undefined ? t('limits.noFigure') : t('limits.percent', { percent: String(view.percent) })
  const word = view.standing === 'near' ? t('limits.status.near') : view.standing === 'reached' ? t('limits.status.reached') : undefined
  const detail = view.standing === 'reset' && view.resetsAt !== undefined
    ? t('limits.resetPassed', { time: clockTime(t, view.resetsAt, now) })
    : view.resetsAt !== undefined ? t('limits.resets', { time: clockTime(t, view.resetsAt, now) }) : undefined
  return (
    <li className={css.bar} data-standing={view.standing} data-window={view.kind}>
      <div className={css.head}>
        <span className={css.title}>{name}</span>
        <span className={css.value}>{word !== undefined && <span className={css.word}>{word} · </span>}{value}</span>
      </div>
      <div className={css.track} role="progressbar" aria-label={t('limits.bar', { title: name, value: word === undefined ? value : `${word}, ${value}` })}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent}>
        <span className={css.fill} style={{ width: `${String(view.percent ?? 0)}%` }} />
      </div>
      {detail !== undefined && <span className={css.detail}>{detail}</span>}
    </li>
  )
}

/** The props of the bars. */
export interface LimitBarsProps {
  /** The agent's stored figures. */
  readonly account: AccountFigures
  /** The time the answer was made. */
  readonly now: number
  /** The copy. */
  readonly t: LimitsTranslate
}

/**
 * The agent's bars with when the figures were seen: "As of" while fresh, "Last seen" once old.
 * @param props - the figures, the time and the copy.
 * @returns the bars, or one line when no figure is stored.
 */
export function LimitBars({ account, now, t }: LimitBarsProps): ReactNode {
  const views = windowViews(account, now)
  const seen = lastSeenAt(account)
  if (views.length === 0) return <p className={css.none}>{t('limits.none')}</p>
  return <>
    <ul className={css.bars}>{views.map(view => <Bar key={view.kind} view={view} now={now} t={t} />)}</ul>
    {seen !== undefined && <p className={css.seen}>{now - seen > FRESH_MS ? t('limits.lastSeen', { time: clockTime(t, seen, now) }) : t('limits.asOf', { time: clockTime(t, seen, now) })}</p>}
  </>
}

/** What "Check now" last did, as a line under the button. */
export interface CheckNote {
  /** The sentence. */
  readonly text: string
  /** Whether it reports a failure. */
  readonly failed: boolean
}

/**
 * The sentence for what a refresh did.
 * @param t - the copy.
 * @param outcome - the refresh's outcome.
 * @param now - the time the answer was made.
 * @returns the note.
 */
export function outcomeNote(t: LimitsTranslate, outcome: RefreshOutcome, now: number): CheckNote {
  switch (outcome.kind) {
    case 'checked': return { text: t('limits.checked'), failed: false }
    case 'failed': return { text: t('limits.failed', { problem: outcome.problem }), failed: true }
    case 'throttled': return { text: t('limits.throttled', { time: clockTime(t, outcome.nextAt, now) }), failed: false }
    case 'not-installed': return { text: t('limits.notAdded'), failed: true }
    case 'refused': return { text: t('limits.refused', { problem: outcome.problem }), failed: true }
    case 'turned-off': return { text: t('limits.turnedOff'), failed: true }
    /* v8 ignore next 2 -- RefreshOutcome is a closed union, so the default holds no reachable statement. */
    default: return outcome satisfies never
  }
}

/** What one "Check now" came to. */
export type CheckResult =
  | { readonly kind: 'done'; readonly note: CheckNote; readonly record: AccountView; readonly now: number }
  | { readonly kind: 'unlock' }
  | { readonly kind: 'failed'; readonly note: CheckNote }

/**
 * Ask the home to check one agent now.
 * @param fetch - the request function.
 * @param t - the copy.
 * @param provider - the agent.
 * @returns the note to show and, when the home answered, the figures after the check; `unlock` for a locked device.
 */
export async function runCheck(fetch: HostFetch, t: LimitsTranslate, provider: AccountView['provider']): Promise<CheckResult> {
  try {
    const answer = await checkAccount(fetch, provider)
    return { kind: 'done', note: outcomeNote(t, answer.outcome, answer.now), record: answer.record, now: answer.now }
  } catch (error) {
    if (isRefused(error, ELEVATION_REQUIRED)) return { kind: 'unlock' }
    const failure = hostFailureOf(error)
    return { kind: 'failed', note: { text: failure.kind === 'refused' ? failure.message : failure.kind === 'unreachable' ? t('limits.unreachable') : t('limits.unreadable'), failed: true } }
  }
}

/** The state of the figures a surface reads. */
export type AccountsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly accounts: readonly AccountView[]; readonly now: number }
  | { readonly kind: 'unavailable'; readonly text: string }

/** What {@link useAccounts} gives a surface. */
export interface AccountsHandle {
  /** What was read. */
  readonly state: AccountsState
  /** Read the stored figures again; never starts a check. */
  readonly reload: () => Promise<void>
  /**
   * Check one agent now and fold the answer in.
   * @param provider - the agent.
   * @returns the note to show, or `unlock` when a locked device was refused.
   */
  readonly check: (provider: AccountView['provider']) => Promise<CheckNote | 'unlock'>
}

/**
 * Read the stored figures once when shown, and offer "Check now". Reading starts no check.
 * @param fetch - the request function.
 * @param t - the copy.
 * @param enabled - whether to read; a hidden surface reads nothing.
 * @returns the state and the actions.
 */
export function useAccounts(fetch: HostFetch, t: LimitsTranslate, enabled = true): AccountsHandle {
  const [state, setState] = useState<AccountsState>({ kind: 'loading' })
  const reload = useCallback(async (): Promise<void> => {
    try {
      const answer = await readAccounts(fetch)
      setState({ kind: 'ready', accounts: answer.accounts, now: answer.now })
    } catch (error) {
      setState({ kind: 'unavailable', text: failureSentence(error, {
        refused: (_code, message) => message, unreachable: t('limits.unreachable'), unreadable: t('limits.unreadable'),
      }) })
    }
  }, [fetch, t])
  useEffect(() => { if (enabled) void reload() }, [enabled, reload])
  const check = useCallback(async (provider: AccountView['provider']): Promise<CheckNote | 'unlock'> => {
    const result = await runCheck(fetch, t, provider)
    if (result.kind === 'done') {
      const { record, now } = result
      setState(previous => previous.kind === 'ready'
        ? { kind: 'ready', accounts: previous.accounts.map(each => each.provider === provider ? record : each), now }
        : previous)
      return result.note
    }
    return result.kind === 'unlock' ? 'unlock' : result.note
  }, [fetch, t])
  return { state, reload, check }
}

/** The props of the card block. */
export interface AgentLimitsProps {
  /** The agent's stored figures. */
  readonly account: AccountFigures
  /** The time the answer was made. */
  readonly now: number
  /** The copy. */
  readonly t: LimitsTranslate
  /** Check now, from {@link useAccounts}. */
  readonly check: AccountsHandle['check']
  /** Whether to show the sign-in line too; the card shows its own, with the file hint standing in, so it says no. */
  readonly signIn?: boolean
}

/**
 * The bars with "Check now" and its outcome. A locked device that is refused sees "Unlock to check" from then on.
 * @param props - the figures, the copy and the check.
 * @returns the block.
 */
export function AgentLimits({ account, now, t, check, signIn = false }: AgentLimitsProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const [locked, setLocked] = useState(false)
  const [note, setNote] = useState<CheckNote | undefined>()
  const run = async (): Promise<void> => {
    setBusy(true)
    setNote(undefined)
    const result = await check(account.provider)
    setBusy(false)
    if (result === 'unlock') {
      setLocked(true)
      setNote({ text: t('limits.unlockNeeded'), failed: false })
      return
    }
    setLocked(false)
    setNote(result)
  }
  const line = signIn ? signInText(t, account) : undefined
  return (
    <div className={css.block} data-limits={account.provider}>
      {line !== undefined && <p className={css.signIn}>{line}</p>}
      <LimitBars account={account} now={now} t={t} />
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy || !account.installed} onClick={() => { void run() }}>
          {busy ? t('limits.checking') : locked ? t('limits.unlockToCheck') : t('limits.check')}
        </Button>
      </div>
      {note !== undefined && <p className={css.note} data-failed={note.failed} role={note.failed ? 'alert' : 'status'}>{note.text}</p>}
    </div>
  )
}
