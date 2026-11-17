// @vitest-environment jsdom
/**
 * Parity between the website replica's simplified chat and the product's real chat, rendered from the same fixture
 * (`FIXTURE.events`). It compares what a person can read (user and assistant message text, the tool call's command and
 * its status word, in document order) and what a person can press (the approval card's buttons, the composer's send
 * button). It cannot see layout, colours, icons, timestamps, step grouping, the folded tool output, or Delorun's
 * "Allow for this chat" choice (that needs Delorun's plugin; the replica draws upstream's `ApprovalCard`). Takes about
 * 13 s (one real-chat mount per test; most of it is module loading).
 * @module @delorun/website/tests/replica-parity.client.spec
 */
// The site resolves React 19 and the product and the brand package React 18, and this project has no React alias. The
// replica's own JSX (src/replica and this file) would build React 19 elements for a React 18 renderer, so its JSX runtime
// is the brand package's React 18 one.
vi.mock('react/jsx-runtime', async () => await import('../../../packages/brand/node_modules/react/jsx-runtime.js'))
vi.mock('react/jsx-dev-runtime', async () => await import('../../../packages/brand/node_modules/react/jsx-dev-runtime.js'))

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyChat, inject as injectChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyTool, inject as injectTool } from '@deepseek-ai/dsh-client-ui-tool/client'
import { apply as applyApproval, inject as injectApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../../../../packages/client/ui-chat/src/chat-settings.ts'
import { en as approvalEn } from '../../../../packages/client/ui-approval/src/client/locales.ts'
import { en as chatEn } from '../../../../packages/client/ui-chat/src/client/locale.ts'
import { en as conversationEn } from '../../../../packages/client/ui-conversation/src/client/locales.ts'
import { en as sidebarEn } from '../../../../packages/client/ui-sidebar/src/client/locales.ts'
import { en as settingsEn } from '../../../../packages/client/ui-settings-general/src/client/locales.ts'
import { en as layoutEn } from '../../../packages/plugin-settings-layout/src/client/locales.ts'
import { VOCABULARY } from '../../../packages/plugin-theme/src/client/vocabulary.ts'
import { ChatScreen, commandOf, pendingApproval } from '../src/replica/screens/ChatScreen.tsx'
import type { ReplicaEvent } from '../src/replica/model.ts'
import { FIXTURE } from '../src/replica/sessions/ordinary-work.fixture.ts'
import { pickStrings } from '../src/replica/strings.ts'

usePinnedBrowserLanguages('en-GB')

const SID = 'parity-session' as SessionId

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')

// jsdom has neither ResizeObserver nor font-loading events; the composer row observes both.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
  else Object.defineProperty(document, 'fonts', fonts)
})

function AppRoot({ renderSlot }: PropsRenderSlots<'main'>) {
  return <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
}

/**
 * The fixture's rows as a live session delivers them: the wire fields the replica leaves out (model source, empty stream)
 * are filled in so the product's projection accepts them.
 */
function wireRows(events: readonly ReplicaEvent[]): SessionEventLikeEntry[] {
  return events.map((row, index): SessionEventLikeEntry => {
    const seq = SessionSeq(index + 1)
    const time = index + 1
    switch (row.type) {
      case 'assistant/message': return { type: 'event', event: { type: row.type, seq, time, surfaceOp: 'append', data: {
        ...row.data, stream: [], message: { ...row.data.message, source: { kind: 'model', provider: 'fixture', model: 'fixture' } },
      } } } as never
      case 'tool/result': return { type: 'event', event: { type: row.type, seq, time, surfaceOp: 'append', data: {
        ...row.data, message: { ...row.data.message, source: { kind: 'tool', callId: row.data.message.toolCallId } },
      } } } as never
      case 'user/message':
      case 'tool/call': return { type: 'event', event: { type: row.type, seq, time, surfaceOp: 'append', data: row.data } } as never
      case 'turn/start':
      case 'turn/end':
      case 'step/start':
      case 'step/end':
      case 'approval/asked':
      case 'approval/decided': return { type: 'event', event: { type: row.type, seq, time, data: row.data } } as never
    }
  })
}

/** The listener the approval plugin subscribed to `approval/request`, and the session context it must be called under. */
type ApprovalListener = (this: unknown, request: { toolName: string, callId?: string, reason?: string }, next: () => Promise<'unavailable'>) => Promise<unknown>

/**
 * Mount the product's Conversation, Chat and Approval plugins over a session holding `events`.
 * @param events - the fixture rows.
 * @param pending - the approval request the Host would forward while the card is up, if any.
 * @returns the rendered root.
 */
async function renderProduct(events: readonly ReplicaEvent[], pending?: { toolName: string, callId: string, reason: string }) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  runtime.ctx.provide('fileDrag', { actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} }, read: () => undefined })
  const chatSettings = stubConfigForm<ChatSettings>()
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: (namespace: string) => namespace === CHAT_SETTINGS_NAMESPACE ? chatSettings.scope : stubConfigForm().scope,
  } as never)
  runtime.ctx.provide('connection', { state: createSnapshotStore('connected') } as never)
  runtime.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn() } as never)
  runtime.ctx.provide('sidebarRight', { openResource: vi.fn(), openTab: vi.fn() } as never)
  runtime.ctx.provide('sidebarRightTabs', { register: vi.fn(() => () => {}), get: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) } as never)
  runtime.ctx.provide('resources', { register: vi.fn(() => () => {}) } as never)
  runtime.remote.provideNamespaces({ session: { openWorkspacePath: vi.fn() } })
  let mainReference: ReturnType<typeof runtime.sessions.retain> | undefined
  const openSession = (id: SessionId): void => {
    const next = runtime.sessions.retain(id, { source: 'mainView' })
    mainReference?.release()
    mainReference = next
  }
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: unknown, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
      openSession(SID)
    }),
    openSession,
  } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]), registerFixed: vi.fn(() => () => {}) })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'F', displayTitle: 'F', cwd: '/proj' },
    session: { loadOlder: vi.fn<ISession['loadOlder']>() },
    events: wireRows(events),
  })
  openSession(SID)
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, AppRoot)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  await runtime.mount({ inject: [...injectTool], apply: applyTool })
  let listener: ApprovalListener | undefined
  const remote = runtime.remote
  const subscribe = remote.$on.bind(remote)
  remote.$on = ((event: string, callback: ApprovalListener) => {
    if (event === 'approval/request') listener = callback
    return subscribe(event, callback as never)
  }) as typeof remote.$on
  await runtime.mount({ inject: [...injectApproval], apply: applyApproval })
  const view = runtime.renderRoot()
  if (pending !== undefined) {
    const scope = runtime.sessions.scope(SID)
    if (listener === undefined || scope === undefined) throw new Error('the approval plugin did not subscribe to approval/request')
    await act(async () => {
      void listener!.call(scope, pending, async () => 'unavailable')
      await Promise.resolve()
    })
  }
  return view
}

const strings = pickStrings({
  conversation: { en: conversationEn },
  chat: { en: chatEn },
  sidebar: { en: sidebarEn },
  settings: { en: settingsEn },
  layout: { en: layoutEn },
}, VOCABULARY)

/**
 * The replica's chat from `events`.
 * @param events - the rows.
 * @param shown - how many show.
 * @param approval - draws the card for a pending approval.
 * @returns the rendered tree.
 */
function renderReplica(events: readonly ReplicaEvent[], shown: number, approval?: Parameters<typeof ChatScreen>[0]['approval']) {
  return render(<ChatScreen events={events} shown={shown} draft="" typing={false} strings={strings} approval={approval} />)
}

/** Text as a person reads it: trimmed, runs of white space as one space. */
const normal = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim()

/** A message or command a person reads, in the order the transcript shows them. */
interface Readable {
  readonly kind: 'user' | 'assistant' | 'command'
  readonly text: string
}

/**
 * The readable texts of a rendered chat, from the markup each rendering draws: the product's message bubbles, assistant
 * step markdown and bash row summary, and the replica's `data-from` bubbles and tool card command.
 * @param container - the product's or the replica's rendered tree.
 * @param side - which rendering `container` is.
 * @returns the user messages, assistant messages and tool commands in document order.
 */
function readableOf(container: HTMLElement, side: 'product' | 'replica'): Readable[] {
  const selector = side === 'product'
    ? '[data-message-bubble], [data-chat-flow-kind="assistant-step"] [class*="_markdown_"], [data-sample="bash"] [class*="_summary_"]'
    : '[data-from], [data-status] code'
  return [...container.querySelectorAll(selector)].map((element): Readable => {
    const text = normal(element.textContent)
    if (side === 'product') return { kind: element.matches('[data-message-bubble]') ? 'user' : element.matches('[class*="_summary_"]') ? 'command' : 'assistant', text }
    return { kind: element.tagName === 'CODE' ? 'command' : element.getAttribute('data-from') === 'person' ? 'user' : 'assistant', text }
  })
}

/** Names of the buttons a person can press, among the ones the replica draws. */
function pressableOf(container: HTMLElement, drawn: readonly string[]): string[] {
  return within(container).queryAllByRole('button').map(button => normal(button.getAttribute('aria-label') ?? button.textContent)).filter(name => drawn.includes(name))
}

/** A line that says how two readable lists differ, or undefined when they are equal. */
function difference(product: readonly Readable[], replica: readonly Readable[]): string | undefined {
  const line = (rows: readonly Readable[]): string => rows.map(row => `${row.kind}: ${row.text}`).join('\n')
  return line(product) === line(replica) ? undefined : `product:\n${line(product)}\nreplica:\n${line(replica)}`
}

describe('replica chat parity', () => {
  it('reads the same messages, command and status as the product for the whole fixture', async () => {
    const product = await renderProduct(FIXTURE.events)
    const productRows = readableOf(product.container, 'product')
    const replica = renderReplica(FIXTURE.events, FIXTURE.events.length)
    const replicaRows = readableOf(replica.container, 'replica')

    expect(productRows.map(row => row.kind)).toEqual(['user', 'assistant', 'command', 'assistant'])
    expect(difference(productRows, replicaRows)).toBeUndefined()

    const call = FIXTURE.events.find(row => row.type === 'tool/call')
    expect(call !== undefined && productRows.find(row => row.kind === 'command')?.text).toBe(call === undefined ? '' : commandOf(call))

    // The product's bash row says nothing for a completed call (its `data-state` is `ok`); it words only running, failed
    // and stopped calls. The replica always words the status, so a completed call reads as the product's `command.done`.
    const row = product.container.querySelector('[data-sample="bash"]')
    expect(row?.getAttribute('data-state')).toBe('ok')
    const card = replica.container.querySelector('[data-status]')
    expect(card?.getAttribute('data-status')).toBe('done')
    expect(normal(card?.querySelector('[class*="status"]')?.textContent)).toBe(strings.chat['command.done'])
    expect(Object.values(chatEn)).toContain(strings.chat['command.done'])

    // Both draw the composer's send button.
    const send = strings.conversation['input.send']
    expect(pressableOf(product.container, [send])).toEqual([send])
    expect(pressableOf(replica.container, [send])).toEqual([send])
    expect(within(product.container).queryByRole('textbox')).not.toBeNull()
    expect(within(replica.container).queryByRole('textbox')).not.toBeNull()
  })

  it('replaces the composer by the approval card while a command waits, and the card has the product buttons', async () => {
    const asked = FIXTURE.events.findIndex(row => row.type === 'approval/asked')
    const through = FIXTURE.events.slice(0, asked + 1)
    const request = pendingApproval(through)
    if (request === undefined) throw new Error('the fixture has no pending approval')
    const product = await renderProduct(through, { toolName: request.toolName, callId: request.callId, reason: request.reason })

    // The real card's buttons include the replica's: the replica draws the product's own ApprovalCard.
    const names = within(product.container).getAllByRole('button').map(button => normal(button.getAttribute('aria-label') ?? button.textContent))
    expect(names).toEqual(expect.arrayContaining([approvalEn.allowOnce, approvalEn.reject]))
    // The product keeps its composer under a hidden fallback wrapper while the card is up, so no textbox is reachable.
    expect(product.container.querySelector('[data-approval-key]')).not.toBeNull()
    expect(within(product.container).queryByRole('textbox')).toBeNull()

    const replica = renderReplica(FIXTURE.events, asked + 1, () => <div data-testid="card" />)
    expect(within(replica.container).queryByTestId('card')).not.toBeNull()
    expect(within(replica.container).queryByRole('textbox')).toBeNull()
    replica.rerender(<ChatScreen events={FIXTURE.events} shown={asked + 1} draft="" typing={false} strings={strings} />)
    expect(within(replica.container).queryByRole('textbox')).not.toBeNull()
  })

  it('reports a difference when the replica text drifts', async () => {
    const product = await renderProduct(FIXTURE.events)
    const drifted = FIXTURE.events.map((row): ReplicaEvent => row.type === 'assistant/message' && row.data.step === 2
      ? { ...row, data: { ...row.data, message: { ...row.data.message, content: [{ type: 'text', text: 'The project has 215 tests in 31 files, and all of them pass.' }] } } }
      : row)
    const replica = renderReplica(drifted, drifted.length)
    expect(difference(readableOf(product.container, 'product'), readableOf(replica.container, 'replica'))).toContain('215 tests')
  })
})
