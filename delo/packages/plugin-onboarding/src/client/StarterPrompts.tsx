/**
 * Starter prompts in the empty state of the first chat onboarding opens: a few chips above the message box. A chip
 * writes its prompt into the message box and sends nothing; the person reads it, changes it and sends it. The chips
 * show only for that chat, only while it has no message, and only while the box holds nothing the person typed.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './StarterPrompts.module.css'

/** The starter prompts, by the number their copy is keyed with. */
export const STARTERS = [1, 2, 3] as const

/** What the chips read and call. */
export interface StarterInjected {
  /** The chat whose empty state offers the prompts. */
  readonly starter: {
    /** @returns the session id, or empty for none. */
    getSnapshot(): string
    /**
     * @param listener - called after each change.
     * @returns the unsubscriber.
     */
    subscribe(listener: () => void): () => void
  }
  /**
   * Write a prompt into a chat's message box without sending it.
   * @param sessionId - the chat.
   * @param text - the prompt.
   */
  readonly prefill: (sessionId: SessionId, text: string) => void
  /** Stop offering the prompts. */
  readonly dismiss: () => void
}

/** The props of the chips in the input dock: the chat and its message box, this plugin's copy and the services. */
export type StarterPromptsProps = Pick<PropsRuntime<'conversation.input.dock'>, 'sessionId' | 'session' | 'input'> & PropsLocale<'deloOnboarding'> & InjectFace<StarterInjected>

/**
 * Render the chips for the chat onboarding opened, while it is empty.
 * @param props - the dock's owner state, this plugin's copy and the services.
 * @returns the chips, or nothing.
 */
export function StarterPrompts({ t, sessionId, session, input, starter, prefill, dismiss }: StarterPromptsProps): ReactNode {
  const offered = useSyncExternalStore(useCallback(listener => starter.subscribe(listener), [starter]), () => starter.getSnapshot())
  if (offered === '' || offered !== sessionId || !session.blank) return null
  const prompts = STARTERS.map(number => ({ number, label: t(`starter.${number}.label`), prompt: t(`starter.${number}.prompt`) }))
  // Text the person typed is theirs; a starter's own text still lets another starter replace it.
  if (input.draft.trim() !== '' && !prompts.some(each => each.prompt === input.draft)) return null
  return (
    <div className={css.row} role="group" aria-label={t('starter.lead')}>
      <span className={css.lead}>{t('starter.lead')}</span>
      <div className={css.chips}>
        {prompts.map(each => (
          <button key={each.number} type="button" className={css.chip} aria-pressed={input.draft === each.prompt} onClick={() => { prefill(sessionId, each.prompt) }}>
            {each.label}
          </button>
        ))}
      </div>
      <button type="button" className={css.dismiss} aria-label={t('starter.dismiss')} onClick={dismiss}>×</button>
    </div>
  )
}
