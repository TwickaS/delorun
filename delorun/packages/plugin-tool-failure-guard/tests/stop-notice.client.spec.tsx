// @vitest-environment jsdom
/** The studio half: which turn endings get the stop notice, what the row says, and what the plugin registers. */
import { Context } from '@deepseek-ai/cordis'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { apply, en, inject, isGuardStop, NS, STOP_NOTICE_KIND, StopNotice, stopNoticeDefinition, zh, type StopNoticeProps } from '../src/client/index.ts'
import { TOOL_FAILURE_GUARD_STOP_REASON } from '../src/tally.ts'

afterEach(cleanup)

/** A `turn/end` event for turn 2 with `reason`. */
function turnEnd(reason: TurnEndReason): SessionEvent {
  return { type: 'turn/end', seq: 41, time: 1_700_000_000_000, data: { turn: 2, reason } } as SessionEvent
}

const GUARD_STOP: TurnEndReason = { kind: 'aborted', reason: { kind: 'hook', reason: TOOL_FAILURE_GUARD_STOP_REASON } }

describe('which turns get the notice', () => {
  it('matches a turn the guard stopped', () => {
    expect(isGuardStop(turnEnd(GUARD_STOP))).toBe(true)
    expect(stopNoticeDefinition.match(turnEnd(GUARD_STOP))).toEqual({ id: '2', role: 'start' })
  })

  it.each<[string, TurnEndReason]>([
    ['a completed turn', { kind: 'completed' }],
    ['a turn the person stopped', { kind: 'aborted', reason: { kind: 'user' } }],
    ['a turn another hook stopped', { kind: 'aborted', reason: { kind: 'hook', reason: 'Delorun is stopping or updating' } }],
  ])('leaves %s alone', (_name, reason) => {
    expect(isGuardStop(turnEnd(reason))).toBe(false)
    expect(stopNoticeDefinition.match(turnEnd(reason))).toBeNull()
  })

  it('builds one Chat node at the turn end\'s position', () => {
    const match = { event: turnEnd(GUARD_STOP), location: { kind: 'unresolved' }, role: 'start' } as ConversationStartMatch
    const base = { key: 'k', kind: stopNoticeDefinition.kind, id: '2', matches: [match], start: match }
    const state = stopNoticeDefinition.start(base as never, match, {} as never)
    const node = stopNoticeDefinition.buildViewNode?.({ ...base, state } as never)
    expect(node).toMatchObject({ kind: STOP_NOTICE_KIND, target: 'chat', anchorSeq: 41, visibility: 'visible', groupTree: 'turn', data: { turn: 2, time: 1_700_000_000_000 } })
  })
})

describe('the row', () => {
  it('says the turn stopped and how to carry on', () => {
    const t = ((key: keyof typeof en) => en[key]) as StopNoticeProps['t']
    const props = { node: { data: { turn: 2, time: 0 } }, t } as never as StopNoticeProps
    render(<StopNotice {...props} />)
    const row = screen.getByRole('status')
    expect(row.textContent).toBe(en['stop.title'] + en['stop.message'])
    // It is the shared alert: an inline warning that stays a polite status.
    expect(row.hasAttribute('data-tool-failure-stop')).toBe(true)
    expect(row.getAttribute('data-kind')).toBe('warning')
    expect(row.getAttribute('data-variant')).toBe('inline')
  })

  it('has Chinese copy for every English key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('registration', () => {
  it('registers the copy, the definition and the row, and removes them on unload', async () => {
    const ctx = new Context()
    const dictionaries = new Map<string, unknown>()
    const definitions = new Set<unknown>()
    const rows = new Map<string, unknown>()
    ctx.provide('locale', { register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } } } as never)
    ctx.provide('uiConversation', { events: { register: (definition: unknown) => { definitions.add(definition); return () => { definitions.delete(definition) } } } } as never)
    ctx.provide('slots', {
      inject: (_: string, register: () => () => void) => register(),
      register: (slot: { name: string; key: string }, component: unknown) => { rows.set(`${slot.name}#${slot.key}`, component); return () => { rows.delete(`${slot.name}#${slot.key}`) } },
    } as never)
    const fiber = ctx.plugin({ name: 'delorun-tool-failure-guard', inject: [...inject], apply })
    await fiber
    expect(dictionaries.get(NS)).toEqual({ en, zh })
    expect([...definitions]).toEqual([stopNoticeDefinition])
    expect(rows.get(`conversation.chat.node#${STOP_NOTICE_KIND}`)).toBe(StopNotice)
    await fiber.dispose()
    expect(dictionaries.size + definitions.size + rows.size).toBe(0)
  })
})
