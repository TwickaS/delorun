/**
 * The line under an external agent's start in the chat: the level the started agent runs at now, as a chip, and one
 * click opens the choice in Settings → Safety → External agents. The started agent comes from the logged call's tool
 * name; a level is a setting, not a logged fact, so the chip shows today's level of that agent.
 */
import { memo, useEffect, useState } from 'react'
import { Button } from '@delorun/brand'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentLevelView } from '@delorun/plugin-delegation-consent/wire'
import { levelChipText } from './AgentLevels.tsx'
import { readAgentLevels } from './consents-api.ts'
import type { HostFetch } from './host-api.ts'
import type { AGENT_LEVEL_NOTICE_KIND } from './agent-level-notice.ts'
import css from './FullAccessStartNotice.module.css'

/** What the plugin supplies the line. */
export interface AgentLevelsNoticeInjected {
  /** Sends the line's same-origin request: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Opens the External agents settings section. */
  openLevels(): void
}

/** The line's props: the Chat node, the consents dictionary and the plugin's face. */
export type AgentLevelsNoticeProps = PropsRuntime<'conversation.chat.node', typeof AGENT_LEVEL_NOTICE_KIND> & PropsLocale<'delorunConsents'> & InjectFace<AgentLevelsNoticeInjected>

/** One quiet line with the started agent's level chip; nothing while the levels cannot be read. */
export const AgentLevelsNotice = memo(function AgentLevelsNotice({ node, t, fetch, openLevels }: AgentLevelsNoticeProps) {
  const [levels, setLevels] = useState<readonly AgentLevelView[]>([])
  useEffect(() => {
    let current = true
    void readAgentLevels(fetch).then((answer) => { if (current) setLevels(answer?.levels ?? []) }, () => {})
    return () => { current = false }
  }, [fetch])
  const started = levels.filter(view => view.provider === node.data.provider)
  if (started.length === 0) return null
  return <div className={css.row} role="status" data-agent-levels-notice="">
    {t('levels.notice')}{' '}
    {started.map(view => <Button key={view.provider} variant="secondary" size="sm" data-level-chip={view.level}
      aria-label={t('levels.chip.change', { agent: view.agent, level: levelChipText(t, view) })} onClick={openLevels}>{view.agent} · {levelChipText(t, view)}</Button>)}
  </div>
})
