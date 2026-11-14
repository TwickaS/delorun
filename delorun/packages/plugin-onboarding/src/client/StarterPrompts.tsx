/**
 * Starter prompts in the empty state of the first chat onboarding opens: a few chips above the message box, fitting
 * what the chat's folder holds. A chip writes its prompt into the message box and sends nothing; the person reads it,
 * changes it and sends it. The chips show only for that chat, only while it has no message, and only while the box holds nothing the person typed. While
 * the prompts are `pending`, the first empty chat whose dock mounts after that takes them; a chat already open then does not.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { PENDING_STARTERS } from '../config.ts'
import css from './StarterPrompts.module.css'

/** The starter prompts, by the number their copy is keyed with. */
export const STARTERS = [1, 2, 3] as const

/** The prompt sets: one per folder kind, and `general` where the folder's kind is not known. */
export const STARTER_SETS = ['general', 'empty', 'code', 'files'] as const

/** One of {@link STARTER_SETS}. */
export type StarterSet = typeof STARTER_SETS[number]

/**
 * @param folder - the kind onboarding recorded for the chat's folder, or empty.
 * @returns the set of prompts that fits it.
 */
export function starterSet(folder: string): StarterSet {
  return (STARTER_SETS as readonly string[]).includes(folder) ? folder as StarterSet : 'general'
}

/** What the chips read and call. */
export interface StarterInjected {
  /** The chat whose empty state offers the prompts. */
  readonly starter: {
    /** @returns the session id, `pending` while the prompts wait for the next empty chat that opens, or empty for none. */
    getSnapshot(): string
    /**
     * @param listener - called after each change.
     * @returns the unsubscriber.
     */
    subscribe(listener: () => void): () => void
  }
  /** @returns what the chat's folder holds, as onboarding recorded it, or empty when it is not known. */
  readonly folder: () => string
  /**
   * Write a prompt into a chat's message box without sending it.
   * @param sessionId - the chat.
   * @param text - the prompt.
   */
  readonly prefill: (sessionId: SessionId, text: string) => void
  /**
   * Offer the prompts in a chat, replacing `pending`.
   * @param sessionId - the chat.
   */
  readonly bind: (sessionId: SessionId) => void
  /** Stop offering the prompts. */
  readonly dismiss: () => void
}

/** The props of the chips in the input dock: the chat and its message box, this plugin's copy and the services. */
export type StarterPromptsProps = Pick<PropsRuntime<'conversation.input.dock'>, 'sessionId' | 'session' | 'input'> & PropsLocale<'delorunOnboarding'> & InjectFace<StarterInjected>

/**
 * Render the chips for the chat onboarding opened, while it is empty.
 * @param props - the dock's owner state, this plugin's copy and the services.
 * @returns the chips, or nothing.
 */
export function StarterPrompts({ t, sessionId, session, input, starter, folder, prefill, bind, dismiss }: StarterPromptsProps): ReactNode {
  const offered = useSyncExternalStore(useCallback(listener => starter.subscribe(listener), [starter]), () => starter.getSnapshot())
  // The chat open when the prompts became pending is an older chat; chats that open after that, or a dock that mounted
  // while they were pending, may take them.
  const arrived = useRef<{ readonly pendingAtMount: boolean; older: SessionId | undefined }>({ pendingAtMount: offered === PENDING_STARTERS, older: undefined })
  if (offered !== PENDING_STARTERS) arrived.current = { pendingAtMount: false, older: undefined }
  else if (!arrived.current.pendingAtMount && arrived.current.older === undefined) arrived.current.older = sessionId
  const takes = offered === PENDING_STARTERS && sessionId !== arrived.current.older && session.blank
  useEffect(() => { if (takes) bind(sessionId) }, [takes, bind, sessionId])
  if (offered === '' || offered !== sessionId || !session.blank) return null
  const set = starterSet(folder())
  const prompts = STARTERS.map(number => ({ number, label: t(`starter.${set}.${number}.label`), prompt: t(`starter.${set}.${number}.prompt`) }))
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
