// @vitest-environment jsdom
/**
 * When upstream's Client Remote service reports that the home refused this page's answer with `LOOPBACK_REQUIRED`
 * (`remote/answer-refused`), the plugin shows the notice that names the refused action and says to answer at the
 * home's own computer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { applyRemoteNotice, REMOTE_NOTICE_ID } from '../src/client/index.ts'
import { en, zh } from '../src/client/devices-locales.ts'
import { createRemoteNoticeSource, refusedActionText, RemoteNotice, type RemoteNoticeSource } from '../src/client/RemoteNotice.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * The refusal upstream reports for one action.
 * @param action - the refused action.
 * @returns the `remote/answer-refused` payload.
 */
const refusal = (action: string | undefined) => ({
  event: 'approval/request', code: 'LOOPBACK_REQUIRED' as const, message: 'the Host\'s sentence', action,
})

describe('the refused-answer notice', () => {
  it('shows each refusal upstream reports, naming the action, until dismissed', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots')
    if (slots === undefined) throw new Error('no slot registry')
    slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } }, inject: () => ({}) },
      ({ renderSlot }) => <>{renderSlot('shell.overlay', {})}</>)
    try {
      await ctx.plugin({ inject: ['slots'], apply: (scope: Context) => { applyRemoteNotice(scope) } }).await()
      const [overlay] = slots.entries('shell.overlay')
      expect(overlay?.options).toMatchObject({ id: REMOTE_NOTICE_ID })
      const face = overlay?.inject?.() as Omit<RemoteNoticeSource, 'show'>
      render(<RemoteNotice t={makeTranslate(en)} useNotice={bindSnapshotSelector(face.hooks.notice)} dismiss={face.dismiss} />)
      expect(screen.queryByRole('alert')).toBeNull()

      act(() => { ctx.emit('remote/answer-refused', refusal('full-access-escalation')) })
      expect(screen.getByRole('alert').textContent).toContain(
        'This needs you at your computer: granting full access. Answer this prompt in the studio on the home\'s computer.')
      fireEvent.click(screen.getByRole('button', { name: en['remote.dismiss'] }))
      expect(screen.queryByRole('alert')).toBeNull()

      act(() => { ctx.emit('remote/answer-refused', refusal('device-remove')) })
      expect(screen.getByRole('alert').textContent).toContain('This needs you at your computer: the action “device-remove”.')
      act(() => { ctx.emit('remote/answer-refused', refusal(undefined)) })
      expect(screen.getByRole('alert').textContent).toContain('This needs you at your computer: answering this prompt.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names the action in Chinese too', () => {
    const t = makeTranslate(zh)
    expect(t('remote.refused', { action: refusedActionText(t, 'full-access-escalation') }))
      .toBe('这需要你在电脑前操作：授予完全访问权限。请在主机所在电脑上的 studio 中回答这个提示')
    expect(refusedActionText(t, 'device-remove')).toBe('操作“device-remove”')
    expect(refusedActionText(t, 'workspace-management')).toBe('管理工作区及其指令')
    expect(refusedActionText(makeTranslate(en), 'workspace-management')).toBe('managing workspaces and their instructions')
    expect(refusedActionText(makeTranslate(en), 'external-agent')).toBe('starting an external agent such as Claude Code or Codex')
    expect(refusedActionText(t, 'external-agent')).toBe('启动 Claude Code 或 Codex 等外部智能体')
    expect(refusedActionText(t, undefined)).toBe('回答这个提示')
  })

  it('goes away by itself after its hold', () => {
    vi.useFakeTimers()
    const source = createRemoteNoticeSource()
    render(<RemoteNotice t={makeTranslate(en)} useNotice={bindSnapshotSelector(source.hooks.notice)} dismiss={source.dismiss} />)
    act(() => { source.show('full-access-escalation') })
    expect(screen.getByRole('alert')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
