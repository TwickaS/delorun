// @vitest-environment jsdom
/** The level chip under an external agent's start: which starts get one, which agent it names, what it says, and the click. */
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

const call = (name: string, callId = 'call-1', seq = 20): SessionEvent => ({ type: 'tool/call', seq, time: 5, data: { callId, name, arguments: '{}', turn: 1, step: 1 } } as never)
const result = (callId = 'call-1', isError = false, seq = 30): SessionEvent => ({ type: 'tool/result', seq, time: 7, data: { message: { source: { callId }, isError, content: [] } } } as never)
const levels = { levels: [
  { provider: 'claude-code', agent: 'Claude Code', level: 'standard', sandboxMissing: { tools: ['socat'], installCommand: 'x' } },
  { provider: 'codex', agent: 'Codex', level: 'careful' },
] }
const answering = (status: number, body: unknown) => vi.fn((_url: string) => Promise.resolve(new Response(JSON.stringify(body), { status })))
const settle = (): Promise<void> => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const props = (fetch: ReturnType<typeof answering>, openLevels = vi.fn(), provider: 'claude-code' | 'codex' = 'claude-code') =>
  ({ node: { data: { provider, time: 0 } }, t: makeTranslate(en), fetch, openLevels }) as never as AgentLevelsNoticeProps

describe('the Definition', () => {
  const build = (state: unknown, start?: unknown) => agentLevelNoticeDefinition.buildViewNode?.({ key: 'k', kind: agentLevelNoticeDefinition.kind, id: 'call-1', matches: [], start, state } as never)

  it('matches only the two hand-off tools\' calls and the results of calls', () => {
    expect(agentLevelNoticeDefinition.match(call('subagent_claude_code'))).toEqual({ id: 'call-1', role: 'start' })
    expect(agentLevelNoticeDefinition.match(call('subagent_codex'))).toEqual({ id: 'call-1', role: 'start' })
    expect(agentLevelNoticeDefinition.match(call('subagent'))).toBeNull()
    expect(agentLevelNoticeDefinition.match(call('bash'))).toBeNull()
    expect(agentLevelNoticeDefinition.match(result())).toEqual({ id: 'call-1', role: 'update' })
    expect(agentLevelNoticeDefinition.match({ type: 'approval/policy', seq: 1, time: 1, data: {} } as never)).toBeNull()
  })

  it.each([['subagent_claude_code', 'claude-code'], ['subagent_codex', 'codex']] as const)('names the agent from the %s call and shows once the result reports a start', (tool, provider) => {
    const match = { event: call(tool), location: { kind: 'unresolved' }, role: 'start' } as ConversationStartMatch
    const state = agentLevelNoticeDefinition.start({} as never, match, {} as never)
    expect(state).toMatchObject({ provider, seq: 20, started: false })
    expect(build(state, match)).toBeNull()
    const started = agentLevelNoticeDefinition.update({ state } as never, { event: result(), location: { kind: 'unresolved' }, role: 'update' } as never)
    expect(build(started, match)).toMatchObject({
      kind: AGENT_LEVEL_NOTICE_KIND, target: 'chat', anchorSeq: 30, groupTree: 'process', data: { provider, time: 7 },
    })
    expect(build(undefined)).toBeNull()
  })

  it('shows nothing for a call whose result is an error, and ignores a tool/call update', () => {
    const match = { event: call('subagent_codex'), location: { kind: 'unresolved' }, role: 'start' } as ConversationStartMatch
    const state = agentLevelNoticeDefinition.start({} as never, match, {} as never)
    const failed = agentLevelNoticeDefinition.update({ state } as never, { event: result('call-1', true), location: { kind: 'unresolved' }, role: 'update' } as never)
    expect(failed).toBe(state)
    expect(build(failed, match)).toBeNull()
    expect(agentLevelNoticeDefinition.update({ state } as never, { event: call('subagent_codex'), location: { kind: 'unresolved' }, role: 'start' } as never)).toBe(state)
  })

  it('refuses to start from an event that is not a hand-off call', () => {
    expect(() => agentLevelNoticeDefinition.start({} as never, { event: result(), location: { kind: 'unresolved' }, role: 'start' } as never, {} as never)).toThrow('requires a hand-off tool/call')
  })
})

describe('the line', () => {
  it('shows the started agent\'s level as one chip, names a missing sandbox, and opens the choice on a click', async () => {
    const fetch = answering(200, levels)
    const open = vi.fn()
    render(<AgentLevelsNotice {...props(fetch, open)} />)
    await settle()
    expect(fetch.mock.calls[0]?.[0]).toBe(DELEGATION_CONSENT_ROUTES.levels)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Claude Code.*Standard · no sandbox/ }).textContent).toBe('Claude Code · Standard · no sandbox')
    expect(screen.queryByRole('button', { name: /Codex/ })).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('shows only Codex\'s level for a Codex start', async () => {
    render(<AgentLevelsNotice {...props(answering(200, levels), vi.fn(), 'codex')} />)
    await settle()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button').textContent).toBe('Codex · Careful')
    expect(screen.getByRole('status').textContent).not.toContain('Claude Code')
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
