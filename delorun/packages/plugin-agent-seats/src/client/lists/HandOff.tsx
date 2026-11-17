/**
 * The hand-off line of the lead chat (look B): one quiet line per `claude_code` or `codex` call, with the agent's
 * state, time and an Open button, and the answer as a quoted block. The block is a view for the person; the lead
 * model still reads only the call's result. The call's result only says the agent started, so the state, time and
 * answer come from the agent's own chat, found in the parent's subagent catalog.
 */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SeatAgent } from '../view.ts'
import { parseHandOffInput, parseHandOffResult, programOf, shortDuration } from './format.ts'
import type { ListsTranslate } from './Parts.tsx'
import css from './Lists.module.css'

/** Business face of the hand-off line. */
export interface HandOffInjected {
  /** Opens a child chat of this session. */
  readonly openChild: (parentSessionId: SessionId, childSessionId: SessionId) => void
}

/** Props of the hand-off line. */
export type HandOffProps = ToolCallViewProps & HandOffInjected & { readonly t: ListsTranslate }

/** The hand-off tool names and the program each hands to. */
export const HAND_OFF_TOOLS: Readonly<Record<string, SeatAgent>> = { claude_code: 'claude-code', codex: 'codex' }

/**
 * One hand-off line.
 * @param props - the call, its phase, the opener and the dictionary.
 * @returns the line, with the answer block once the agent has answered.
 */
export function HandOffLine(props: HandOffProps) {
  const { t, sessionId, openChild, useSessions } = props
  const agent = HAND_OFF_TOOLS[props.toolName]
  const argsRaw = props.phase === 'preparing' ? '' : props.phase === 'start' ? props.block.argsRaw : props.block.call?.argsRaw ?? ''
  const input = parseHandOffInput(argsRaw)
  const result = props.phase === 'result' ? parseHandOffResult(props.block.meta) : undefined
  const failed = props.phase === 'result' && props.block.isError
  const childId = useSessions((state) => {
    const catalog = state.projectionsBySession[sessionId]?.values.subagentCatalog ?? []
    const named = result?.name === undefined ? undefined : catalog.findLast(entry => entry.mode === 'continuable' && entry.name === result.name)
    const labelled = named ?? (input.task === '' ? undefined : catalog.findLast(entry => entry.label === input.task))
    return labelled?.id
  })
  const summary = useSessions(state => childId === undefined ? undefined : state.byId[childId])
  const seat = useSessions(state => childId === undefined ? undefined : state.projectionsBySession[childId]?.values.agentSeat)
  if (agent === undefined) return null
  const program = programOf(agent)
  const colour = agent === 'claude-code' ? 'violet' : 'teal'
  const timing = summary?.projectionValues?.subagentTiming
  const ms = timing === undefined ? 0 : timing.settledMs + (timing.active === undefined ? 0 : Math.max(0, timing.active.through - timing.active.since))
  const running = failed ? false : props.phase !== 'result' || summary?.running === true
  const stateText = failed
    ? t('handoff.failed', { time: shortDuration(ms) })
    : running ? t('handoff.running', { time: shortDuration(ms) }) : t('handoff.finished', { time: shortDuration(ms) })
  const title = input.task === '' ? t('handoff.lineNoTask', { agent: program }) : t('handoff.line', { agent: program, task: input.task })
  const open = childId === undefined ? undefined : () => { openChild(sessionId, childId) }
  const answer = running || failed ? undefined : seat?.lastAnswer
  return (
    <div className={css.handoff} data-handoff={agent} data-state={failed ? 'failed' : running ? 'running' : 'finished'}>
      <div className={css.handoffRow}>
        <span className={`${css.mono} ${css.handoffMono}`} data-colour={colour} data-outside aria-hidden>
          {agent === 'claude-code' ? 'CC' : 'CX'}<span className={css.arrow}>↗</span>
        </span>
        <span className={css.handoffTitle} title={title}>{title}</span>
        <span className={css.spacer} />
        <span className={css.state}>{stateText}</span>
        {open !== undefined && (
          <button type="button" className={css.open} aria-label={t('handoff.open.aria', { task: input.task, agent: program })} onClick={open}>
            {t('handoff.open')}
          </button>
        )}
      </div>
      {result?.withoutAsking === true && <span className={css.noAsk}>{t('handoff.fullAccess')}</span>}
      {answer !== undefined && answer !== '' && (
        <blockquote className={css.quote} data-colour={colour} data-handoff-answer>
          <span className={css.quoteTitle}>{t('handoff.answer.title', { agent: program })}</span>
          <p className={css.quoteText}>{answer}</p>
          {open !== undefined && <button type="button" className={css.open} onClick={open}>{t('handoff.answer.open')}</button>}
        </blockquote>
      )}
    </div>
  )
}
