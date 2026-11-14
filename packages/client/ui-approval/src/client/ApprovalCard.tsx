/** Shared approval presentation; each caller retains its decision policy and answer channel. */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contract/slots.ts'
import css from './ApprovalPanel.module.css'
import { ApprovalWarning } from './ApprovalWarning.tsx'

/**
 * Render one decision with caller-owned actions and an optional persistent choice.
 * @param props Request identity, copy, actions and correlated detail.
 * @returns The shared approval card, reset for each request.
 */
export function ApprovalCard(props: FactoryComponentPropsOf<'conversation.approval.card'>) {
  return <ApprovalFlow key={props.requestKey} {...props} />
}

function ApprovalFlow(props: FactoryComponentPropsOf<'conversation.approval.card'>) {
  const {
    requestKey, title, description, subject, warning, allowLabel, grants, escalatesTo, canAnswer, onAllow, onReject, onAlways, t,
  } = props
  const detail = props.callId === undefined ? null : props.renderSlot('conversation.approval.detail', { callId: props.callId })
  const [answered, setAnswered] = useState(false)
  const [offered, setOffered] = useState(false)
  const waiting = useRef(false)
  const active = useRef(true)
  const composing = useRef(false)
  const compositionEnded = useRef(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  const offer = useCallback((shown: boolean): void => { if (active.current) setOffered(shown) }, [])
  const answer = (send: () => Promise<void>): Promise<void> => {
    if (waiting.current || !canAnswer()) return Promise.resolve()
    waiting.current = true
    setAnswered(true)
    const sent = send()
    void sent.catch(() => {
      if (!active.current || !canAnswer()) return
      waiting.current = false
      setAnswered(false)
    })
    return sent
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const element = event.target as Element
    if (event.defaultPrevented || !event.currentTarget.contains(document.activeElement)
      || element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null) return
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    if (event.key === 'Enter' && element.closest('button, a[href], [role="button"]') !== null) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
    if (event.repeat || composing.current || compositionEnded.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    void answer(event.key === 'Enter' ? onAllow : onReject)
  }
  const grantActions = grants === undefined ? null : props.renderSlot('conversation.approval.action', {
    grants, toolName: props.toolName, callId: props.callId, allow: () => answer(onAllow),
    answered, canAnswer: () => !waiting.current && canAnswer(),
  })
  const choices = escalatesTo === undefined ? null : props.renderSlot('conversation.approval.choice', {
    escalatesTo, toolName: props.toolName, callId: props.callId, allow: () => answer(onAllow),
    answered, canAnswer: () => !waiting.current && canAnswer(),
    offer,
  })
  return (
    <div className={css.root} data-approval-key={requestKey} aria-busy={answered}
      onKeyDown={keydown}
      onKeyUpCapture={() => { compositionEnded.current = false }}
      onCompositionStartCapture={() => { composing.current = true }}
      onCompositionEndCapture={() => { composing.current = false; compositionEnded.current = true }}>
      <div className={subject === undefined ? css.card : `${css.card} ${css.withSubject}`}>
        <div className={css.strip}><StateDot state={answered ? 'ongoing' : 'warning'} />{t('waiting')}</div>
        <div
          className={css.body}
          data-approval-scroll=""
          tabIndex={0}
          role="group"
          aria-label={t('detail.aria')}
        >
          {subject !== undefined && <div className={css.subject}>
            {subject.icon !== undefined && <img src={subject.icon} alt="" width={40} height={40} draggable={false} />}
            <strong>{subject.name}</strong>
          </div>}
          <div className={css.heading}>
            <div className={css.headline}>{title}</div>
            {warning !== undefined && <ApprovalWarning warning={warning} />}
          </div>
          {description !== undefined && <p className={css.description}>{description}</p>}
          {detail !== null && <div className={css.command}>{detail}</div>}
        </div>
        {grantActions !== null && <div className={css.grantActions}>{grantActions}</div>}
        <div className={offered ? `${css.actionRow} ${css.actionRowWrap}` : css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered} onClick={() => { void answer(onReject) }}>
            {t('reject')}
          </Button>
          <Button variant={onAlways === undefined && !offered ? 'primary' : 'outline'} disabled={answered} onClick={() => { void answer(onAllow) }}>
            {allowLabel ?? t('allowOnce')}
          </Button>
          {onAlways !== undefined && <Button variant="primary" disabled={answered} onClick={() => { void answer(onAlways) }}>
            {t('allowAlways')}
          </Button>}
          {choices}
        </div>
      </div>
    </div>
  )
}
