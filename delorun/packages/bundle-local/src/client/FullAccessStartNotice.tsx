import { memo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FULL_ACCESS_START_KIND } from './full-access-start.ts'
import css from './FullAccessStartNotice.module.css'

/** The line's props: the Chat node and the consents dictionary. */
export type FullAccessStartNoticeProps = PropsRuntime<'conversation.chat.node', typeof FULL_ACCESS_START_KIND> & PropsLocale<'delorunConsents'>

/** One quiet line saying an external agent started without a question because the chat is in Full access. */
export const FullAccessStartNotice = memo(function FullAccessStartNotice({ t }: FullAccessStartNoticeProps) {
  return <div className={css.row} role="status" data-full-access-start="">{t('agents.fullAccessStarted')}</div>
})
