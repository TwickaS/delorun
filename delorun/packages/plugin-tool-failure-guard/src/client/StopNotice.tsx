import { memo } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StopNotice.module.css'

/** The notice's props: the Chat node and the plugin's copy. */
export type StopNoticeProps = PropsRuntime<'conversation.chat.node', 'tool-failure-stop'> & PropsLocale<'delorunToolFailureGuard'>

/** One status row under a turn the tool-failure guard stopped: what happened and how to carry on. */
export const StopNotice = memo(function StopNotice({ t }: StopNoticeProps) {
  return (
    <div className={css.row} role="status" data-tool-failure-stop="">
      <StateDot state="warning" className={css.dot} />
      <div className={css.copy}>
        <span className={css.title}>{t('stop.title')}</span>
        <span className={css.message}>{t('stop.message')}</span>
      </div>
    </div>
  )
})
