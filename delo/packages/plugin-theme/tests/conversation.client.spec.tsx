// @vitest-environment jsdom
/** Settings → Conversation writes upstream's chat display settings, and its preview draws each choice. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CustomDisplay } from '@deepseek-ai/dsh-client-ui-chat'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { presentationPolicyFor } from '../../../../packages/client/ui-chat/src/client/presentation-policy.ts'
import { displayMode, DISPLAY_MODES, partsOf, PRESET_PARTS, type ChatDisplaySettings, type Preset } from '../src/client/conversation.ts'
import { en, zh } from '../src/client/conversation-locales.ts'
import { ConversationPreview } from '../src/client/ConversationPreview.tsx'
import { ConversationSection } from '../src/client/ConversationSection.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const t = makeTranslate(en)
const PARTS: CustomDisplay = PRESET_PARTS.detailed

/**
 * Render the section on a chat settings form that accepts writes.
 * @param value - the stored chat settings.
 */
function open(value: ChatDisplaySettings, writable = true) {
  const handle = stubConfigForm<ChatDisplaySettings>()
  const writes: Array<[string, unknown]> = []
  handle.set.mockImplementation((field: string, next: unknown) => {
    writes.push([field, next])
    return Promise.resolve(writes.length < 100)
  })
  handle.publish({ status: 'ready', value, writable })
  render(<ConversationSection t={t} settings={handle.scope} />)
  return { handle, writes }
}

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }

describe('the display parts of each preset', () => {
  it.each(['compact', 'standard', 'detailed', 'verbose'] as const)('match what upstream\'s %s mode shows', (mode: Preset) => {
    const policy = presentationPolicyFor(mode)
    expect(PRESET_PARTS[mode]).toEqual({
      thinking: policy.thinking,
      thinkingWindowLines: policy.thinkingWindowLines,
      stepGrouping: policy.stepGrouping,
      liveProcessDetail: policy.liveProcessDetail,
      openTerminalCards: policy.openTerminalCards,
      foldCompletedTurns: policy.foldCompletedTurns,
    })
  })

  it('read a stored mode, falling back to upstream\'s default for a missing or legacy value, and take Custom\'s own parts', () => {
    expect(DISPLAY_MODES.map(mode => displayMode(mode))).toEqual([...DISPLAY_MODES])
    expect([displayMode(undefined), displayMode(null), displayMode('normal'), displayMode('expanded')]).toEqual(['detailed', 'detailed', 'detailed', 'detailed'])
    expect(partsOf('verbose', undefined)).toBe(PRESET_PARTS.verbose)
    expect(partsOf('custom', undefined)).toBe(PRESET_PARTS.detailed)
    const custom = { ...PARTS, thinking: 'window' as const }
    expect(partsOf('custom', custom)).toBe(custom)
  })
})

describe('the Conversation section', () => {
  it('chooses a display mode, and a mode already chosen writes nothing', async () => {
    const { writes } = open({ transcriptView: 'standard' })
    await click(screen.getByRole('radio', { name: /Standard/ }))
    await click(screen.getByRole('radio', { name: /Verbose/ }))
    await click(screen.getByRole('radio', { name: /Custom/ }))
    expect(writes).toEqual([['transcriptView', 'verbose'], ['transcriptView', 'custom']])
  })

  it('changes a part of a preset by switching to Custom seeded with that preset\'s parts', async () => {
    const { writes } = open({ transcriptView: 'verbose' })
    await click(screen.getByRole('radio', { name: 'Always open' }))
    expect(writes).toEqual([['customDisplay', { ...PRESET_PARTS.verbose, thinking: 'expanded' }], ['transcriptView', 'custom']])
  })

  it('changes a part of Custom in place, with every part reachable: thinking, window height, grouping, live detail, terminals, folding and its timing', async () => {
    const stored: CustomDisplay = { ...PARTS, thinking: 'window', thinkingWindowLines: 6 }
    const { writes } = open({ transcriptView: 'custom', customDisplay: stored, collapseTiming: 'completion', foldedReplies: 'all' })
    await click(screen.getByRole('tab', { name: '10 lines' }))
    await click(screen.getByRole('tab', { name: en['grouping.none'] }))
    await click(screen.getByRole('switch', { name: en.liveDetail }))
    await click(screen.getByRole('tab', { name: en['terminals.open'] }))
    await click(screen.getByRole('tab', { name: en['timing.next-input'] }))
    await click(screen.getByRole('tab', { name: en['replies.final'] }))
    await click(screen.getByRole('switch', { name: en.fold }))
    expect(writes).toEqual([
      ['customDisplay', { ...stored, thinkingWindowLines: 10 }],
      ['customDisplay', { ...stored, stepGrouping: 'none' }],
      ['customDisplay', { ...stored, liveProcessDetail: false }],
      ['customDisplay', { ...stored, openTerminalCards: true }],
      ['collapseTiming', 'next-input'],
      ['foldedReplies', 'final'],
      ['customDisplay', { ...stored, foldCompletedTurns: false }],
    ])
  })

  it('hides the window height unless thinking is a sliding window, and the folding choices unless turns fold', () => {
    open({ transcriptView: 'custom', customDisplay: { ...PARTS, foldCompletedTurns: false } })
    expect(screen.queryByText(en.window)).toBeNull()
    expect(screen.queryByText(en.timing)).toBeNull()
  })

  it('keeps Coming soon thinking unchosen and any other thinking choice already made unwritten', async () => {
    const { writes } = open({ transcriptView: 'standard' })
    const word = screen.getByRole('radio', { name: /Word by word/ })
    expect(word.hasAttribute('disabled')).toBe(true)
    await click(word)
    await click(screen.getByRole('radio', { name: 'One-line preview' }))
    expect(writes).toEqual([])
  })

  it('previews the finished or the running turn', async () => {
    open({ transcriptView: 'detailed' })
    expect(document.querySelector('[class*="pvWorking"]')).toBeNull()
    expect(screen.getByText(en['preview.answer'])).toBeTruthy()
    await click(within(screen.getByRole('tablist', { name: en.preview })).getByRole('tab', { name: en['preview.running'] }))
    expect(document.querySelector('[class*="pvWorking"]')?.textContent).toBe(en['preview.running'])
    expect(screen.queryByText(en['preview.answer'])).toBeNull()
  })

  it('shows the defaults before a value is stored, locks its choices when not writable, and reports a refused write', async () => {
    const empty = stubConfigForm<ChatDisplaySettings>()
    empty.publish({ status: 'ready', value: undefined, writable: true })
    const { unmount } = render(<ConversationSection t={t} settings={empty.scope} />)
    expect(screen.getByRole('radio', { name: /Detailed/ }).getAttribute('aria-checked')).toBe('true')
    unmount()
    const { writes } = open({}, false)
    expect(screen.getByRole('radio', { name: /Compact/ }).hasAttribute('disabled')).toBe(true)
    expect(writes).toEqual([])
  })

  it('reports a write the Host refused or could not carry', async () => {
    const handle = stubConfigForm<ChatDisplaySettings>()
    handle.publish({ status: 'ready', value: {}, writable: true })
    handle.set.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce(true)
    render(<ConversationSection t={t} settings={handle.scope} />)
    await click(screen.getByRole('radio', { name: /Compact/ }))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
    await click(screen.getByRole('radio', { name: /Standard/ }))
    expect(screen.getByRole('alert')).toBeTruthy()
    await click(screen.getByRole('radio', { name: /Verbose/ }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('has a Chinese text for every English key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('the sample chat', () => {
  const draw = (parts: Partial<CustomDisplay>, running: boolean, foldedReplies: 'all' | 'final' = 'all') =>
    render(<ConversationPreview t={t} parts={{ ...PARTS, ...parts }} foldedReplies={foldedReplies} running={running} />)

  it('draws the finished turn folded behind one row, with every reply or the final answer only', () => {
    const { container, unmount } = draw({ foldCompletedTurns: true }, false)
    expect(container.textContent).toContain(en['preview.folded'])
    expect(container.textContent).toContain(en['preview.interim'])
    expect(container.textContent).toContain(en['preview.answer'])
    unmount()
    const final = draw({ foldCompletedTurns: true }, false, 'final')
    expect(final.container.textContent).not.toContain(en['preview.interim'])
  })

  it.each([
    ['title', 'preview', 0],
    ['preview', 'preview', 1],
    ['expanded', 'body', 0],
    ['live', 'preview', 1],
  ] as const)('draws %s thinking from a finished turn', (thinking, _kind, previews) => {
    const { container } = draw({ foldCompletedTurns: false, stepGrouping: 'none', thinking }, false)
    expect(container.textContent).toContain(en['preview.thinkingTitle'])
    expect(container.querySelectorAll('[class*="pvPreview"]')).toHaveLength(previews)
    expect(container.textContent?.includes(en['preview.thinking'])).toBe(thinking === 'expanded')
  })

  it('draws the steps one by one with the terminal open, or grouped into a row', () => {
    const open = draw({ foldCompletedTurns: false, stepGrouping: 'none', openTerminalCards: true }, false)
    expect(open.container.textContent).toContain(en['preview.read1'])
    expect(open.container.textContent).toContain(en['preview.terminal'])
    open.unmount()
    const closed = draw({ foldCompletedTurns: false, stepGrouping: 'none' }, true)
    expect(closed.container.textContent).not.toContain(en['preview.terminal'])
    expect(closed.container.querySelector('[class*="pvDot"][data-running]')).not.toBeNull()
    closed.unmount()
    const grouped = draw({ foldCompletedTurns: false, stepGrouping: 'collapsed' }, false)
    expect(grouped.container.textContent).toContain(en['preview.group'])
    grouped.unmount()
    const live = draw({ foldCompletedTurns: false, stepGrouping: 'collapsed', liveProcessDetail: true }, true)
    expect(live.container.textContent).toContain(en['preview.groupRunning'])
    live.unmount()
    const past = draw({ foldCompletedTurns: false, stepGrouping: 'history' }, false)
    expect(past.container.textContent).toContain(en['preview.group'])
    past.unmount()
    const current = draw({ foldCompletedTurns: false, stepGrouping: 'history' }, true)
    expect(current.container.textContent).toContain(en['preview.read1'])
    current.unmount()
    const quiet = draw({ foldCompletedTurns: false, stepGrouping: 'collapsed', liveProcessDetail: false }, true)
    expect(quiet.container.textContent).toContain(en['preview.group'])
  })

  it('streams a sliding window word by word while running, and shows it whole at rest or when motion is reduced', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const words = en['preview.thinking'].split(' ').length
    const running = draw({ foldCompletedTurns: false, thinking: 'window', thinkingWindowLines: 3 }, true)
    const text = () => running.container.querySelector('[class*="pvWindow"] p')?.textContent ?? ''
    expect(text().split(' ')).toHaveLength(8)
    act(() => { vi.advanceTimersByTime(90 * 3) })
    expect(text().split(' ')).toHaveLength(11)
    act(() => { vi.advanceTimersByTime(90 * words) })
    expect(text().split(' ').length).toBeLessThanOrEqual(words)
    expect(running.container.querySelector('[class*="pvWindow"]')?.getAttribute('data-streaming')).toBe('true')
    running.unmount()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const reduced = draw({ foldCompletedTurns: false, thinking: 'window' }, true)
    expect(reduced.container.querySelector('[class*="pvWindow"] p')?.textContent).toBe(en['preview.thinking'])
    reduced.unmount()
    vi.stubGlobal('matchMedia', undefined)
    const rest = draw({ foldCompletedTurns: false, thinking: 'window' }, false)
    expect(rest.container.querySelector('[class*="pvWindow"] p')?.textContent).toBe(en['preview.thinking'])
  })

  it('opens live thinking only while the turn runs, and shows the last streamed sentence as the running preview', () => {
    const running = draw({ foldCompletedTurns: false, thinking: 'live' }, true)
    expect(running.container.textContent).toContain(en['preview.thinking'])
    running.unmount()
    const preview = draw({ foldCompletedTurns: false, thinking: 'preview' }, true)
    expect(preview.container.querySelectorAll('[class*="pvPreview"]')).toHaveLength(1)
  })
})
