// @vitest-environment jsdom
/**
 * The product's side of the replica's chat parity: the real transcript, rendered by Delorun's own conversation, chat, tool
 * and approval plugins (React 18) from the replica's fixture, read into an outline of what a person can read and press, and
 * compared with the committed `ordinary-work.outline.json`, which the website's `replica-parity.client.spec.tsx` compares its
 * replica with. It reads one scene per chapter end of the fixture and sees the same things as that spec: user and assistant
 * message text, each tool row's visible title, command and status word, the step group's label, and the buttons of the
 * approval card and the composer. It cannot see layout, colours, icons, timestamps, the folded output or text that is only
 * visually hidden, and the product's approval plugin alone does not draw Delorun's "Allow for this chat" (that needs
 * Delorun's plugin). When the fixture, the product's chat or its dictionaries change the outline, the file is stale and this
 * spec names the command that rewrites it: `REPLICA_OUTLINE_WRITE=1 node_modules/.bin/vitest run --config delorun/vitest.config.ts --project fork-client
 * delorun/apps/website/tests/product/replica-outline.client.spec.tsx`. It takes about 10 s (one real-chat mount per scene).
 * @module @delorun/website/tests/product/replica-outline.client.spec
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../../../../../packages/client/ui-chat/src/chat-settings.ts'
import { VOCABULARY } from '../../../../packages/plugin-theme/src/client/vocabulary.ts'
import { en as conversationEn } from '../../../../../packages/client/ui-conversation/src/client/locales.ts'
import { outlineOf, parseOutline, scenesOf, type Outline, type OutlineSelectors } from '../../src/replica/outline.ts'
import type { ReplicaEvent } from '../../src/replica/model.ts'
import { CHAPTER_FILES } from '../../src/replica/sessions/index.ts'
import { FIXTURE } from '../../src/replica/sessions/ordinary-work.session.ts'

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


/** The conversation dictionary with Delorun's vocabulary laid over upstream's, as the product shows it. */
const sendLabel = { ...conversationEn, ...VOCABULARY['conversation']?.en }['input.send']

/**
 * How the product's markup maps to items: its message bubbles and assistant step text; the bash row's title, summary
 * (the command, or the settlement word of a failed or stopped call) and the step group's label; the approval card's
 * buttons and the composer's send button. The composer sits under a wrapper with inline `display: none` while the card
 * is up. The running bash row and group draw their text a second time as an inert decoration, and the running row has a
 * visually hidden status; both are left out.
 */
const PRODUCT: OutlineSelectors = {
  readable: [
    '[data-message-bubble]',
    '[data-chat-flow-kind="assistant-step"] [class*="_markdown_"]',
    '[data-sample="bash"] [class*="_title_"]:not([aria-hidden="true"] *)',
    '[data-sample="bash"] [class*="_summary_"]:not([aria-hidden="true"] *)',
    '[data-process-activity] [class*="_label_"]:not([aria-hidden="true"] *)',
  ].join(', '),
  buttons: `[data-approval-key] button, button[aria-label=${JSON.stringify(sendLabel)}]:not([data-chain-overlay-fallback][style*="display: none"] *)`,
  kindOf: element => element.matches('[data-message-bubble]') ? 'user'
    : element.matches('[data-process-activity] *') ? 'group'
    : element.matches('[class*="_title_"]') ? 'title'
    : element.matches('[class*="_errorSummary_"], [class*="_stoppedSummary_"]') ? 'status'
    : element.matches('[class*="_summary_"]') ? 'command'
    : 'assistant',
}

/** The committed outline the website's replica is compared with. */
const OUTLINE_FILE = resolve(import.meta.dirname, '../../src/replica/sessions/ordinary-work.outline.json')

/** The command that rewrites {@link OUTLINE_FILE}. */
const REGENERATE = 'REPLICA_OUTLINE_WRITE=1 node_modules/.bin/vitest run --config delorun/vitest.config.ts --project fork-client delorun/apps/website/tests/product/replica-outline.client.spec.tsx'

/**
 * Read every scene from the product's real chat.
 * @returns the outline of each chapter end of the fixture; a scene that leaves an approval waiting has the request fired.
 */
async function productOutline(): Promise<Outline> {
  const outline: Outline[number][] = []
  for (const scene of scenesOf(CHAPTER_FILES['ordinary-work'], FIXTURE.events)) {
    const view = await renderProduct(scene.events, scene.pending)
    outline.push(outlineOf(view.container, scene.id, PRODUCT))
    cleanup()
  }
  return outline
}

describe('replica outline of the product', () => {
  it('matches the committed outline the replica is held to', async () => {
    const outline = await productOutline()
    if (process.env['REPLICA_OUTLINE_WRITE'] === '1') {
      writeFileSync(OUTLINE_FILE, `${JSON.stringify(outline, null, 2)}\n`)
      return
    }
    expect(outline, `ordinary-work.outline.json is stale; regenerate it with: ${REGENERATE}`).toEqual(parseOutline(readFileSync(OUTLINE_FILE, 'utf8')))
  })
})
