/**
 * The agent chat's banner: the coloured rule, the opening card with its chips, and the state card when the agent is
 * starting, at a plan limit, not signed in, waiting for a model or gone. It renders nothing in any chat that is not a
 * live agent's.
 */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SeatClient } from './actions.ts'
import { AGENT_NAMES, loginCommand, type AgentSeatView, type SeatAgent } from './view.ts'
import css from './Seat.module.css'

/** The dictionary as the slot's `t`. */
export type SeatTranslate = TranslateNS<'delorunAgentSeats'>

/** What the studio injects. */
export interface BannerInjected {
  /** The studio's seat actions, when it supplies them. */
  readonly client: SeatClient | undefined
  /** Copy a text to the clipboard. */
  readonly copy: (text: string) => Promise<void>
  /** Format an epoch-millisecond time of day. */
  readonly clock: (epochMs: number) => string
}

/** Props of the banner entry. */
export interface BannerProps extends BannerInjected {
  /** The open chat. */
  readonly sessionId: string
  /** The open chat's projection reads. */
  readonly useProjection: UseProjection
  /** The dictionary. */
  readonly t: SeatTranslate
}

/**
 * The monogram letters of a program.
 * @param agent - the program.
 * @returns two letters.
 */
export function monogram(agent: SeatAgent): string {
  return agent === 'claude-code' ? 'CC' : 'CX'
}

/**
 * The chips of the opening card, in the order the person reads them.
 * @param seat - the agent.
 * @param t - the dictionary.
 * @param clock - the time formatter.
 * @returns the chips' texts with whether each one warns.
 */
export function chipsOf(seat: AgentSeatView, t: SeatTranslate, clock: (epochMs: number) => string): readonly { readonly text: string; readonly warn: boolean }[] {
  const name = AGENT_NAMES[seat.agent]
  const chips: { text: string; warn: boolean }[] = []
  if (seat.version !== undefined) chips.push({ text: t('chip.version', { agent: name, version: seat.version }), warn: false })
  chips.push({ text: seat.ownSettings === '' ? t('chip.settingsUnknown') : t('chip.settings', { settings: seat.ownSettings }), warn: false })
  if (seat.sandbox !== undefined) chips.push({ text: seat.sandbox === 'on' ? t('chip.sandboxed') : t('chip.noSandbox'), warn: seat.sandbox === 'off' })
  if (seat.plan !== undefined) chips.push({ text: t('chip.plan', { plan: seat.plan }), warn: false })
  if (seat.fiveHourPercent !== undefined) {
    chips.push({
      text: seat.fiveHourResetAt === undefined
        ? t('chip.fiveHourNoReset', { percent: String(seat.fiveHourPercent) })
        : t('chip.fiveHour', { percent: String(seat.fiveHourPercent), time: clock(seat.fiveHourResetAt) }),
      warn: seat.fiveHourPercent >= 80,
    })
  }
  if (seat.weeklyPercent !== undefined) chips.push({ text: t('chip.weekly', { percent: String(seat.weeklyPercent) }), warn: seat.weeklyPercent >= 80 })
  return chips
}

/** Copies the sign-in command and says so for a moment. */
function CopyCommand({ command, copy, t }: { readonly command: string; readonly copy: BannerInjected['copy']; readonly t: SeatTranslate }) {
  const [done, setDone] = useState(false)
  return (
    <div className={css.row}>
      <code className={css.code}>{command}</code>
      <Button variant="outline" size="sm" onClick={() => { void copy(command).then(() => { setDone(true) }, () => { setDone(false) }) }}>
        {done ? t('state.copied') : t('state.copy')}
      </Button>
    </div>
  )
}

/** The state card under the opening card, or null while the agent just works. */
function StateCard({ seat, sessionId, t, client, copy, clock }: { readonly seat: AgentSeatView; readonly sessionId: string; readonly t: SeatTranslate } & BannerInjected) {
  const agent = AGENT_NAMES[seat.agent]
  const [busy, setBusy] = useState(false)
  if (seat.state === 'starting') {
    return <div className={css.state} role="status"><span className={css.stateTitle}>{t('state.starting', { agent })}</span></div>
  }
  if (seat.state === 'limit') {
    return (
      <div className={css.state} role="status" data-state="limit">
        <span className={css.stateTitle}>
          {seat.resetAt === undefined ? t('state.limitNoTime', { agent }) : t('state.limit', { agent, time: clock(seat.resetAt) })}
        </span>
        <span className={css.text}>{t('state.limitHint')}</span>
        <div className={css.row}>
          <Button variant="primary" size="sm" disabled={client === undefined || busy}
            onClick={() => {
              /* v8 ignore next -- the button is disabled without a client; the guard narrows the type. */
              if (client === undefined) return
              setBusy(true)
              void client.resume(sessionId).finally(() => { setBusy(false) })
            }}>
            {t('state.resume')}
          </Button>
        </div>
      </div>
    )
  }
  if (seat.state === 'not-signed-in') {
    return (
      <div className={`${css.state} ${css.stateError}`} role="alert" data-state="not-signed-in">
        <span className={css.stateTitle}>{t('state.notSignedIn', { agent })}</span>
        <span className={css.text}>{t('state.notSignedInHint')}</span>
        <CopyCommand command={loginCommand(seat.agent)} copy={copy} t={t} />
      </div>
    )
  }
  if (seat.state === 'model-needed' && seat.modelPicker !== undefined) {
    const picker = seat.modelPicker
    return (
      <div className={css.state} role="group" aria-label={t('picker.title', { agent })} data-state="model-needed">
        <span className={css.stateTitle}>{t('picker.title', { agent })}</span>
        <span className={css.text}>{t('picker.body', { agent })}</span>
        <ul className={css.models}>
          {picker.offered.map(model => (
            <li key={model.id}>
              <Button variant={model.id === picker.planDefault ? 'primary' : 'outline'} size="sm" disabled={client === undefined || busy}
                onClick={() => {
                  /* v8 ignore next -- the button is disabled without a client; the guard narrows the type. */
                  if (client === undefined) return
                  setBusy(true)
                  void client.chooseModel(sessionId, model.id).finally(() => { setBusy(false) })
                }}>
                {t('picker.choose', { model: model.label })}
              </Button>
              {model.id === picker.planDefault && <span className={css.tag}>{t('picker.default')}</span>}
            </li>
          ))}
        </ul>
        <span className={css.text} data-picker-applies="">{t('picker.applies')}</span>
      </div>
    )
  }
  if (seat.state === 'ended') {
    return (
      <div className={css.state} role="status" data-state="ended">
        <span className={css.stateTitle}>{t('state.ended', { agent })}</span>
        {seat.endedReason !== undefined && <span className={css.text}>{t('state.endedWhy', { reason: seat.endedReason })}</span>}
      </div>
    )
  }
  return null
}

/**
 * The banner: rule, opening card and state card. Renders nothing in a chat without a live agent.
 * @param props - the open chat, its projection reads, the dictionary and the studio's actions.
 * @returns the banner, or `null`.
 */
export function Banner({ sessionId, useProjection, t, client, copy, clock }: BannerProps) {
  const seat = useProjection('agentSeat')
  // `null` follows the first turn; a person's click then keeps the card open or shut.
  const [open, setOpen] = useState<boolean | null>(null)
  if (seat === undefined || seat === null) return null
  const agent = AGENT_NAMES[seat.agent]
  const collapsed = (open ?? (seat.turns ?? 0) === 0) === false
  return (
    <>
      <div className={css.rule} data-agent={seat.agent} data-seat-rule="" role="presentation" />
      <div className={css.root} data-agent={seat.agent} data-seat-banner="">
        {collapsed
          ? (
            <button type="button" className={css.line} aria-expanded={false} aria-label={t('line.expand')} data-seat-line=""
              onClick={() => { setOpen(true) }}>
              <span className={css.mono} aria-hidden>{monogram(seat.agent)}</span>
              <span className={css.lineName}>{t('line.outside', { agent })}</span>
              {seat.fiveHourPercent !== undefined && (
                <span className={css.meter} role="img" aria-label={t('line.limit', { percent: String(seat.fiveHourPercent) })}>
                  <span className={css.meterFill} style={{ width: `${String(Math.min(100, seat.fiveHourPercent))}%` }} />
                </span>
              )}
              {seat.fiveHourPercent !== undefined && <span className={css.lineText}>{t('line.limit', { percent: String(seat.fiveHourPercent) })}</span>}
              {seat.sandbox !== undefined && (
                <span className={seat.sandbox === 'off' ? `${css.chip} ${css.chipWarn}` : css.chip}>{seat.sandbox === 'on' ? t('chip.sandboxed') : t('chip.noSandbox')}</span>
              )}
            </button>
          )
          : (
            <section className={css.card} aria-label={t('rule.label', { agent })}>
              <span className={css.mono} aria-hidden>{monogram(seat.agent)}</span>
              <div className={css.cardBody}>
                <span className={css.title}>{t('card.title', { agent })}</span>
                <p className={css.text}>{t('card.body')}</p>
                <ul className={css.chips}>
                  {chipsOf(seat, t, clock).map(chip => (
                    <li key={chip.text} className={chip.warn ? `${css.chip} ${css.chipWarn}` : css.chip}>{chip.text}</li>
                  ))}
                </ul>
              </div>
              {(seat.turns ?? 0) > 0 && (
                <button type="button" className={css.toggle} aria-expanded onClick={() => { setOpen(false) }}>{t('line.collapse')}</button>
              )}
            </section>
          )}
        <StateCard seat={seat} sessionId={sessionId} t={t} client={client} copy={copy} clock={clock} />
      </div>
    </>
  )
}

/**
 * The line above the message box.
 * @param props - the open chat's projection reads and the dictionary.
 * @returns the line, or `null` in a chat without a live agent.
 */
export function ComposerNote({ useProjection, t }: Pick<BannerProps, 'useProjection' | 't'>) {
  const seat = useProjection('agentSeat')
  if (seat === undefined || seat === null) return null
  return (
    <div className={css.note} data-agent={seat.agent} data-seat-note="">
      <span className={css.noteMono} aria-hidden>{monogram(seat.agent)}</span>
      {t('composer.note', { agent: AGENT_NAMES[seat.agent] })}
    </div>
  )
}
