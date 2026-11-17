// @vitest-environment jsdom
/** The level chips under an external agent's start: which starts get them, what they say, and the click. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DELEGATION_CONSENT_ROUTES } from '@delorun/plugin-delegation-consent/wire'
import { en } from '../src/client/consents-locales.ts'
import { AgentLevelsNotice, type AgentLevelsNoticeProps } from '../src/client/AgentLevelsNotice.tsx'
import { AGENT_LEVEL_NOTICE_KIND, agentLevelNoticeDefinition } from '../src/client/agent-level-notice.ts'

afterEach(cleanup)

const catalog = (mode: string, data: unknown = { childId: 'child-1', mode }): SessionEvent => ({ type: 'subagent/catalog', seq: 30, time: 7, data } as never)
const levels = { levels: [
  { provider: 'claude-code', agent: 'Claude Code', level: 'standard', sandboxMissing: { tools: ['socat'], installCommand: 'x' } },
  { provider: 'codex', agent: 'Codex', level: 'careful' },
] }
const answering = (status: number, body: unknown) => vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })))
const settle = (): Promise<void> => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const props = (fetch: ReturnType<typeof answering>, openLevels = vi.fn()) =>
  ({ node: { data: { time: 0 } }, t: makeTranslate(en), fetch, openLevels }) as never as AgentLevelsNoticeProps

describe('the Definition', () => {
  it('matches an external execution only and builds one node at its start', () => {
    expect(agentLevelNoticeDefinition.match(catalog('external'))).toEqual({ id: 'child-1', role: 'start' })
    expect(agentLevelNoticeDefinition.match(catalog('continuable'))).toBeNull()
    expect(agentLevelNoticeDefinition.match(catalog('external', 'text'))).toBeNull()
    expect(agentLevelNoticeDefinition.match(catalog('external', null))).toBeNull()
    expect(agentLevelNoticeDefinition.match({ type: 'approval/policy', seq: 1, time: 1, data: {} } as never)).toBeNull()
    expect(agentLevelNoticeDefinition.match({ type: 'subagent/catalog', seq: 1, time: 1 } as never)).toBeNull()
    const match = { event: catalog('external'), location: { kind: 'unresolved' }, role: 'start' } as ConversationStartMatch
    const state = agentLevelNoticeDefinition.start({} as never, match, {} as never)
    const base = { key: 'k', kind: agentLevelNoticeDefinition.kind, id: 'child-1', matches: [match], start: match }
    expect(agentLevelNoticeDefinition.buildViewNode?.({ ...base, state } as never)).toMatchObject({
      kind: AGENT_LEVEL_NOTICE_KIND, target: 'chat', anchorSeq: 30, groupTree: 'process', data: { time: 7 },
    })
    expect(agentLevelNoticeDefinition.buildViewNode?.({ ...base, state: undefined } as never)).toBeNull()
    expect(agentLevelNoticeDefinition.update({ state } as never, {} as never)).toBe(state)
  })
})

describe('the line', () => {
  it('shows each agent\'s level as a chip, names a missing sandbox, and opens the choice on a click', async () => {
    const fetch = answering(200, levels)
    const open = vi.fn()
    render(<AgentLevelsNotice {...props(fetch, open)} />)
    await settle()
    expect(fetch.mock.calls[0]?.[0]).toBe(DELEGATION_CONSENT_ROUTES.levels)
    expect(screen.getByRole('button', { name: /Claude Code.*Standard · no sandbox/ }).textContent).toBe('Claude Code · Standard · no sandbox')
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Careful')
  })

  it('shows nothing while the levels cannot be read or the profile has no consent', async () => {
    for (const fetch of [answering(404, { error: 'NOT_FOUND', message: 'no' }), vi.fn(() => Promise.reject(new Error('offline')))]) {
      const { container } = render(<AgentLevelsNotice {...props(fetch as never)} />)
      await settle()
      expect(container.textContent).toBe('')
      cleanup()
    }
  })
})
