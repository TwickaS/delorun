import { memo } from 'react'
import { Alert } from '@delorun/brand/alert'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** The notice's props: the Chat node and the plugin's copy. */
export type StopNoticeProps = PropsRuntime<'conversation.chat.node', 'tool-failure-stop'> & PropsLocale<'delorunToolFailureGuard'>

/** One inline alert under a turn the tool-failure guard stopped: what happened and how to carry on. */
export const StopNotice = memo(function StopNotice({ t }: StopNoticeProps) {
  return <Alert kind="warning" role="status" data-tool-failure-stop="" title={t('stop.title')} line={t('stop.message')} />
})
