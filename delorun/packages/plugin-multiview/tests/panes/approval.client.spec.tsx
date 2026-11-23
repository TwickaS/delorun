// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ApprovalCard } from '@deepseek-ai/dsh-client-ui-approval/src/client/ApprovalCard.tsx'
import { en as approvalEn } from '@deepseek-ai/dsh-client-ui-approval/src/client/locales.ts'
// The seat's card is read from its sources: the client lane resolves only upstream packages to sources, and this spec needs the card itself.
import { SeatApproval, type ApprovalInjected, type SeatApprovalProps } from '../../../plugin-agent-seats/src/client/Approval.tsx'
import { en as seatsEn } from '../../../plugin-agent-seats/src/client/locales.ts'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneBody, type PaneBodyProps } from '../../src/panes/PaneBody.tsx'
import { MultiviewLayer, type LayerProps } from '../../src/panel/Layer.tsx'
import { layoutsEn } from '../../src/layout/index.ts'
import { createLayerRegistry } from '../../src/panel/keys.ts'
import { createPhoneDots } from '../../src/panel/dots.tsx'
import { en } from '../../src/panes/locales.ts'
import { A, B, CHAT, makeStore } from '../entry/fixtures.ts'
import { listOf } from '../entry/harness.tsx'
import { fakeViewport } from '../phone/helpers.tsx'

/**
 * Approvals in panes. A pane draws the chat's own composer, whose chain elects the chat's own approval card, so a pane's approval is
 * the card the main chat would show, bound to that chat's request. These specs mount the real cards in the layer's panes: the
 * agent seat's card (with and without the page's reach, which is Face ID's confirmation) and the stock card with its allow gate.
 */
let viewport: ReturnType<typeof fakeViewport>
beforeEach(() => {
  viewport = fakeViewport(1440)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 })
})
afterEach(() => {
  cleanup()
  viewport.restore()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
})

type ApprovalCardProps = FactoryComponentPropsOf<'conversation.approval.card'>

/** The page's standing: one object, because the card reads it as an external store. */
const STANDING = {}

const ChatContext = createContext<string>('none')

/** What one chat's pending request records. */
interface Pending {
  readonly answer: ReturnType<typeof vi.fn>
  readonly onAllow: ReturnType<typeof vi.fn>
  readonly onReject: ReturnType<typeof vi.fn>
}

const pendingOf = (): Pending => ({ answer: vi.fn(() => Promise.resolve()), onAllow: vi.fn(() => Promise.resolve()), onReject: vi.fn(() => Promise.resolve()) })

function setup(body: (chat: string, pending: Pending) => ReactNode) {
  const made = makeStore()
  for (const pin of [A, B]) made.store.pin(CHAT, pin)
  made.store.open(CHAT)
  const list = createSnapshotStore(listOf({ main: CHAT, catalogs: { [CHAT]: [A, B] } }))
  const statuses = createSnapshotStore(new Map([A, B].map(id => [id, { pendingInteraction: { kind: 'approval' } }])))
  const pending = new Map<string, Pending>([[A, pendingOf()], [B, pendingOf()]])
  const sessions = {
    subagentAddress: () => undefined,
    retain: (target: string) => ({ sessionId: target, binding: { session: { cancel: vi.fn() } }, release: vi.fn() }) as never,
  }
  const props = {
    sessionId: CHAT,
    children: <div data-main-content />,
    useSessions: <S,>(select: (state: ReturnType<typeof list.getSnapshot>) => S): S => useSyncExternalStore(list.subscribe, () => select(list.getSnapshot())),
    useSessionStatus: <S,>(select: (state: ReturnType<typeof statuses.getSnapshot>) => S): S => useSyncExternalStore(statuses.subscribe, () => select(statuses.getSnapshot())),
    SessionProvider: ({ session, children }: { session: { sessionId: string }; children: ReactNode }) => <ChatContext.Provider value={session.sessionId}>{children}</ChatContext.Provider>,
    renderSlot: (key: string): ReactNode => (key === 'multiview.pane.body' ? <Body body={body} pending={pending} /> : <div data-header />),
    multiview: made.store, sessions, openFull: vi.fn(), clock: String, dots: createPhoneDots(), t: makeTranslate(en), layoutsT: makeTranslate(layoutsEn), layers: createLayerRegistry(),
  }
  render(<MultiviewLayer {...(props as never as LayerProps)} />)
  return { pending }
}

function Body({ body, pending }: { body: (chat: string, pending: Pending) => ReactNode; pending: Map<string, Pending> }) {
  const chat = useContext(ChatContext)
  return <div data-body={chat}>{body(chat, pending.get(chat)!)}</div>
}

const paneOf = (chat: string): HTMLElement => document.querySelector<HTMLElement>(`[data-body="${chat}"]`)!

/** The seat card for a chat's request, with or without a reach (Face ID's confirmation of an Allow). */
function seatCard(chat: string, pending: Pending, reach: ApprovalInjected['reach']): ReactNode {
  const matched = { sessionId: chat, callId: `call-${chat}`, toolName: 'claude-code.Bash', grants: 'external-agent', reason: `Bash in ${chat}`, answerable: true, answer: pending.answer }
  return <SeatApproval {...({ matched, t: makeTranslate(seatsEn), reach } as never as SeatApprovalProps)} />
}

describe('approvals in panes', () => {
  it('draws each pane\'s approval inside that pane, from that chat\'s own request', () => {
    setup((chat, pending) => seatCard(chat, pending, undefined))
    for (const chat of [A, B]) {
      const card = within(paneOf(chat)).getByRole('group', { name: 'Waiting for your approval' })
      expect(card.textContent).toContain(`Bash in ${chat}`)
    }
    expect(document.querySelectorAll('[data-seat-approval]')).toHaveLength(2)
  })

  it('settles only the request of the pane that was answered, through that page\'s confirmation', async () => {
    const confirm = vi.fn(() => Promise.resolve(true))
    const reach = { get: () => STANDING, subscribe: () => () => undefined, confirm } as never as ApprovalInjected['reach']
    const { pending } = setup((chat, request) => seatCard(chat, request, reach))
    fireEvent.click(within(paneOf(A)).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => { expect(pending.get(A)!.answer).toHaveBeenCalledWith('allowed-once') })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith({ sessionId: A, callId: `call-${A}`, grants: 'external-agent', value: 'allowed-once' })
    expect(pending.get(B)!.answer).not.toHaveBeenCalled()
    expect(within(paneOf(B)).getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(false)
  })

  it('does not answer a pane\'s Allow when the confirmation is refused, and leaves the card answerable', async () => {
    const reach = { get: () => STANDING, subscribe: () => () => undefined, confirm: () => Promise.resolve(false) } as never as ApprovalInjected['reach']
    const { pending } = setup((chat, request) => seatCard(chat, request, reach))
    fireEvent.click(within(paneOf(A)).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => { expect(within(paneOf(A)).getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(false) })
    expect(pending.get(A)!.answer).not.toHaveBeenCalled()
  })

  it('offers Reject only in a pane of a page with no reach, and Reject still answers only that chat', async () => {
    const { pending } = setup((chat, request) => seatCard(chat, request, undefined))
    for (const chat of [A, B]) {
      expect(within(paneOf(chat)).queryByRole('button', { name: 'Allow once' })).toBeNull()
      expect(within(paneOf(chat)).getAllByRole('button').map(button => button.textContent)).toEqual(['Reject'])
    }
    fireEvent.click(within(paneOf(B)).getByRole('button', { name: 'Reject' }))
    await waitFor(() => { expect(pending.get(B)!.answer).toHaveBeenCalledWith('rejected') })
    expect(pending.get(A)!.answer).not.toHaveBeenCalled()
  })
})

/** A grant action that installs a gate on its own card, as Face ID's answer action does. */
function GateAction({ gate, gateAllow }: { gate: () => Promise<boolean>; gateAllow: (next: (() => Promise<boolean>) | null) => void }) {
  useEffect(() => { gateAllow(gate); return () => { gateAllow(null) } }, [gate, gateAllow])
  return null
}

describe('the allow gate in panes', () => {
  function stockCard(chat: string, pending: Pending, gate: () => Promise<boolean>): ReactNode {
    const props = {
      requestKey: `request-${chat}`, title: `Run in ${chat}`, grants: 'external-agent', canAnswer: () => true,
      onAllow: pending.onAllow, onReject: pending.onReject, t: makeTranslate(approvalEn),
      renderSlot: (key: string, owner: { gateAllow: (next: (() => Promise<boolean>) | null) => void }) => (key === 'conversation.approval.action' ? <GateAction gate={gate} gateAllow={owner.gateAllow} /> : null),
    }
    return <ApprovalCard {...(props as never as ApprovalCardProps)} />
  }

  it('holds each pane\'s Allow behind that card\'s own gate: one pane\'s refusal neither sends nor blocks the other', async () => {
    const refuse = vi.fn(() => Promise.resolve(false))
    const accept = vi.fn(() => Promise.resolve(true))
    const { pending } = setup((chat, request) => stockCard(chat, request, chat === A ? refuse : accept))
    fireEvent.click(within(paneOf(A)).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => { expect(refuse).toHaveBeenCalledTimes(1) })
    expect(pending.get(A)!.onAllow).not.toHaveBeenCalled()
    fireEvent.click(within(paneOf(B)).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => { expect(pending.get(B)!.onAllow).toHaveBeenCalledTimes(1) })
    expect(accept).toHaveBeenCalledTimes(1)
    expect(refuse).toHaveBeenCalledTimes(1)
    expect(pending.get(A)!.onAllow).not.toHaveBeenCalled()
  })

  it('never gates Reject', async () => {
    const gate = vi.fn(() => Promise.resolve(false))
    const { pending } = setup((chat, request) => stockCard(chat, request, gate))
    fireEvent.click(within(paneOf(A)).getByRole('button', { name: 'Reject' }))
    await waitFor(() => { expect(pending.get(A)!.onReject).toHaveBeenCalledTimes(1) })
    expect(gate).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(2)
  })
})

// The composition below mounts the real pane body inside the real layer; the factory stub stands for `conversation.content`, whose
// composer chain elects the chat's approval card with the page's grant step as its grant action. The step is a stand-in for Face ID's
// (`bundle-local`'s own spec covers the minting): it records the grant it would mint from the chat id its slot props carry, which the
// pane body takes from the pane's chat reference, and it decides the confirmation.
describe('the grant step through the real pane body', () => {
  /** What a step would mint, from the slot props it received. */
  interface Minted { readonly agent: string; readonly callId: string | undefined; readonly grants: string }

  function GrantStep({ sessionId, callId, grants, gateAllow, minted, confirm }: {
    sessionId: string; callId: string | undefined; grants: string
    gateAllow: (next: (() => Promise<boolean>) | null) => void; minted: Minted[]; confirm: (chat: string) => boolean
  }) {
    useEffect(() => {
      gateAllow(() => { minted.push({ agent: sessionId, callId, grants }); return Promise.resolve(confirm(sessionId)) })
      return () => { gateAllow(null) }
    }, [gateAllow, sessionId, callId, grants, minted, confirm])
    return null
  }

  /** The pane body as the layer renders it: the real component over a factory that mounts the chat's card and the grant step. */
  function paneBody(requests: Map<string, Pending>, minted: Minted[], confirm: (chat: string) => boolean) {
    return function Pane(props: { readonly chat: string }) {
      const { chat } = props
      const sources = {
        sessionId: chat,
        useSession: (select: (value: object) => unknown) => select({ blank: false, awaitingFirstTurn: false, running: true, promptAttempted: true, openState: 'open' }),
        useConversation: (select: (value: { activeTargets: Set<string> }) => unknown) => select({ activeTargets: new Set() }),
        useSessions: (select: (value: { byId: Record<string, { blank: boolean }> }) => unknown) => select({ byId: { [chat]: { blank: false } } }),
        compact: true,
        // The slot kit gives the factory's children the pane body's own chat as `sessionId`.
        renderFactorySlot: () => {
          const request = requests.get(chat)!
          const card = {
            requestKey: `request-${chat}`, title: `Run in ${chat}`, grants: 'external-agent', callId: `call-${chat}`, toolName: 'claude-code', canAnswer: () => true,
            onAllow: request.onAllow, onReject: request.onReject, t: makeTranslate(approvalEn),
            renderSlot: (key: string, owner: { grants: string; callId: string | undefined; gateAllow: (next: (() => Promise<boolean>) | null) => void }) => (
              key === 'conversation.approval.action'
                ? <GrantStep sessionId={chat} callId={owner.callId} grants={owner.grants} gateAllow={owner.gateAllow} minted={minted} confirm={confirm} />
                : null),
          }
          return <ApprovalCard {...(card as never as ApprovalCardProps)} />
        },
      }
      return <PaneBody {...(sources as never as PaneBodyProps)} />
    }
  }

  it('mints for the pane\'s own chat, never the main chat\'s, and sends the answer once it is confirmed', async () => {
    const requests = new Map<string, Pending>()
    const minted: Minted[] = []
    const Pane = paneBody(requests, minted, () => true)
    const { pending } = setup((chat, request) => { requests.set(chat, request); return <Pane chat={chat} /> })
    fireEvent.click(within(paneOf(B)).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => { expect(pending.get(B)!.onAllow).toHaveBeenCalledTimes(1) })
    expect(minted).toEqual([{ agent: B, callId: `call-${B}`, grants: 'external-agent' }])
    expect(JSON.stringify(minted)).not.toContain(CHAT)
    expect(pending.get(A)!.onAllow).not.toHaveBeenCalled()
  })

  it('sends nothing when the confirmation of a pane is refused, and leaves that pane answerable', async () => {
    const requests = new Map<string, Pending>()
    const minted: Minted[] = []
    const Pane = paneBody(requests, minted, () => false)
    const { pending } = setup((chat, request) => { requests.set(chat, request); return <Pane chat={chat} /> })
    fireEvent.click(within(paneOf(A)).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => { expect(minted).toHaveLength(1) })
    await waitFor(() => { expect(within(paneOf(A)).getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(false) })
    expect(pending.get(A)!.onAllow).not.toHaveBeenCalled()
    expect(pending.get(B)!.onAllow).not.toHaveBeenCalled()
  })
})
