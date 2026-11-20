// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatOnlyViews, PaneBody, type PaneBodyProps } from '../../src/panes/PaneBody.tsx'

afterEach(cleanup)

interface Chat { readonly running?: boolean; readonly blank?: boolean; readonly openState?: string; readonly summaryBlank?: boolean }

function setup(compact: boolean, chat: Chat = {}) {
  const renderFactorySlot = vi.fn(() => null)
  const session = { running: chat.running ?? false, blank: chat.blank ?? false, awaitingFirstTurn: false, promptAttempted: false, openState: chat.openState ?? 'open' }
  const props = {
    sessionId: 'chat',
    useSession: (select: (value: typeof session) => unknown) => select(session),
    useConversation: (select: (value: { activeTargets: Set<string> }) => unknown) => select({ activeTargets: new Set() }),
    useSessions: (select: (value: { byId: Record<string, { blank: boolean | undefined }> }) => unknown) => select({ byId: { chat: { blank: chat.summaryBlank } } }),
    renderFactorySlot, compact,
  }
  render(<PaneBody {...(props as never as PaneBodyProps)} />)
  return renderFactorySlot as never as { mock: { calls: Array<[string, { variant: string; phase: string; hero: boolean }, { slots: { views: unknown } }]> } }
}

describe('the pane body', () => {
  it('renders the shared conversation content in the pane variant for the compact reply box', () => {
    const [key, input] = setup(true, { running: true }).mock.calls[0]!
    expect(key).toBe('conversation.content')
    expect(input).toEqual({ variant: 'pane', phase: 'active', hero: false })
  })

  it('renders the embedded variant, with the full composer, when the compact box is off', () => {
    expect(setup(false, { running: true }).mock.calls[0]![1].variant).toBe('embedded')
  })

  it('selects the chat view only and overrides nothing else, so the chat\'s own composer chain and approval card stay in force', () => {
    // A pane that replaced the composer or an approval seat in `slots` would be a second approval path.
    expect(setup(true).mock.calls[0]![2]).toEqual({ slots: { views: ChatOnlyViews } })
    cleanup()
    expect(setup(false).mock.calls[0]![2]).toEqual({ slots: { views: ChatOnlyViews } })
  })

  it('settles while a blank chat replays and shows the hero once it is open and blank', () => {
    expect(setup(true, { blank: true, openState: 'loading' }).mock.calls[0]![1].phase).toBe('settling')
    cleanup()
    expect(setup(true, { blank: true, openState: 'open' }).mock.calls[0]![1]).toMatchObject({ phase: 'hero', hero: true })
  })
})
