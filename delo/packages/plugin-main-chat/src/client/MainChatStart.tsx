/**
 * The main chat's first message. Upstream's composer asks for a workspace
 * before a chat's first turn and the main chat is outside every workspace,
 * so until the main chat's first prompt this composer takes the stock one's
 * place; the stock composer returns once the prompt is sent.
 */
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'conversation.composer' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './MainChatStart.module.css'

/** What the composer does. */
export interface MainChatStartInjected {
  /**
   * Send the main chat's first message.
   * @param text - the message, sent as one text block.
   * @returns when the session controller took the prompt; rejects when it refused it.
   */
  readonly send: (text: string) => Promise<void>
}

/** The composer's props: the chain's standard props, its dictionary and its injected call. */
export type MainChatStartProps = PropsRuntime<'conversation.composer'> & PropsLocale<'deloMainChat'> & InjectFace<MainChatStartInjected>

/**
 * The main chat's message card: Enter sends, Shift+Enter starts a new line, and a failed send keeps the draft.
 * @param props - the dictionary and the call that sends the message.
 * @returns the card.
 */
export function MainChatComposer({ t, send }: Pick<MainChatStartProps, 't' | 'send'>) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'editing' | 'sending' | 'failed'>('editing')
  const message = text.trim()
  const sending = phase === 'sending'

  const submit = (): void => {
    if (message === '' || sending) return
    setPhase('sending')
    send(message).then(() => {
      setText('')
      setPhase('editing')
    }, (error: unknown) => {
      // The session controller's refusal is in the session's own prompt error too; the card keeps the draft for another try.
      console.warn('delo-main-chat: the message was not sent', error)
      setPhase('failed')
    })
  }
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    submit()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <form className={css.card} onSubmit={onSubmit}>
      <textarea
        className={css.input}
        aria-label={t('start.input')}
        placeholder={t('start.placeholder')}
        rows={2}
        value={text}
        readOnly={sending}
        onChange={(event) => { setText(event.target.value); if (phase === 'failed') setPhase('editing') }}
        onKeyDown={onKeyDown}
      />
      <div className={css.actions}>
        {phase === 'failed' && <span className={css.error} role="alert">{t('start.failed')}</span>}
        <button type="submit" className={css.send} aria-label={t('start.send')} disabled={message === '' || sending}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M8 1.5 14.2 7.7l-1.4 1.4L9 5.3V14.5H7V5.3L3.2 9.1 1.8 7.7Z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </form>
  )
}

/**
 * Render the first-message composer.
 * @param props - the dictionary and the call that sends the message.
 * @returns the composer.
 */
export function MainChatStart({ t, send }: Pick<MainChatStartProps, 't' | 'send'>) {
  return (
    <div className={css.root} data-delo-main-chat-start="">
      <h2 className={css.title}>{t('start.title')}</h2>
      <p className={css.lead}>{t('start.lead')}</p>
      <MainChatComposer t={t} send={send} />
    </div>
  )
}
