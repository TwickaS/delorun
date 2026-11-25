/**
 * A page for the redesigned agents list's pictures: the real upstream catalog component (`SubagentCatalogAction`) with
 * Delorun's pin, control bar and footer registered into its slots, over the real colour tokens. The query sets how many
 * agents the catalog holds (`agents=8` or `agents=32`), the theme (`theme=dark`) and whether the fold is open (`fold=1`).
 */
import '../../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import { ICON_SYMBOLS } from '@deepseek-ai/dsh-client-ui-primitives'
import { createRoot } from 'react-dom/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { useSyncExternalStore } from 'react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { allowAllAccess, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SubagentCatalogAction, type SubagentCatalogActionProps } from '../../../../../../packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx'
import { en as subagentEn } from '../../../../../../packages/client/ui-subagent/src/client/locales.ts'
import { DEFAULT_MULTIVIEW_SETTINGS } from '../../../src/config.ts'
import { Footer, Header, PinButton, type EntryInjected } from '../../../src/entry/Entry.tsx'
import { en } from '../../../src/entry/locales.ts'
import { layoutsEn } from '../../../src/layout/index.ts'
import { MultiviewStore } from '../../../src/entry/state.ts'
import css from './page.module.css'

/** The document icon sprite the theme plugin mounts, so the primitives' icons draw. */
function mountIconSprite(): void {
  const ns = 'http://www.w3.org/2000/svg'
  const sprite = document.createElementNS(ns, 'svg')
  sprite.setAttribute('aria-hidden', 'true')
  sprite.style.cssText = 'position: absolute; width: 0; height: 0; overflow: hidden'
  for (const [id, markup] of Object.entries(ICON_SYMBOLS)) {
    const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
    const symbol = document.createElementNS(ns, 'symbol')
    for (const { name, value } of root.attributes) if (!['width', 'height', 'xmlns', 'class', 'aria-hidden'].includes(name)) symbol.setAttribute(name, value)
    symbol.id = id
    symbol.append(...[...root.childNodes].map(node => document.importNode(node, true)))
    sprite.append(symbol)
  }
  document.body.prepend(sprite)
}
mountIconSprite()

const params = new URLSearchParams(location.search)
const agentCount = Number(params.get('agents') ?? '8')
const dark = params.get('theme') === 'dark'
if (dark) document.body.dataset.dsDarkTheme = ''

const sid = SessionId
const CHAT = sid('chat')
const NAMES = ['Reviewer', 'Migration writer', 'Test runner', 'Docs pass', 'Type check', 'Changelog', 'Schema audit', 'Copy pass']
const MONOS = ['CC', 'CX', 'T', 'D', 'T', 'C', 'S', 'P']
const COLOURS = ['#7c5cff', '#0f9d8a', '#3b82f6', '#e0a100', '#64748b', '#64748b', '#0f9d8a', '#7c5cff']
const AGENTS = Array.from({ length: agentCount }, (_, index) => ({
  id: sid(`a${String(index)}`),
  name: `${NAMES[index % NAMES.length] ?? 'Agent'}${index < NAMES.length ? '' : ` ${String(Math.floor(index / NAMES.length) + 1)}`}`,
  mono: MONOS[index % MONOS.length] ?? 'A',
  colour: COLOURS[index % COLOURS.length] ?? '#64748b',
  running: index < 3,
  waiting: index === 1,
  tokens: 12_400 + index * 3_100,
  seconds: 48 + index * 37,
}))

const store = new MultiviewStore({
  settings: createSnapshotStore({ ...DEFAULT_MULTIVIEW_SETTINGS, maxPanes: 6 }),
  persistence: { load: () => undefined, save: () => {} },
  windowArea: () => ({ width: 4000, height: 3000 }),
})
store.pinAll(CHAT, AGENTS.slice(0, 2).map(agent => agent.id))

const list = createSnapshotStore({
  ids: [], phase: 'ready', projectionsBySession: {},
  byId: Object.fromEntries(AGENTS.map(agent => [agent.id, {
    id: agent.id, displayTitle: agent.name, running: agent.running, retainedBy: {}, blank: false, updatedAt: 0,
    origin: 'subagent', parentId: CHAT,
    projectionValues: {
      subagentTiming: { settledMs: agent.seconds * 1_000, lastTurnCompleted: !agent.running },
      tokenUsage: { uncachedInputTokens: agent.tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  }])),
})
list.set({ ...list.getSnapshot(), projectionsBySession: { [CHAT]: {
  values: { subagentCatalog: AGENTS.map(agent => ({ id: agent.id, createdAt: 0, mode: 'subagent', label: agent.name })) }, state: 'ready', error: null,
} } } as never)
list.set({ ...list.getSnapshot(), byId: { [CHAT]: { id: CHAT, displayTitle: 'Refactor billing service', running: true, retainedBy: { mainView: 1 }, blank: false, updatedAt: 0 }, ...list.getSnapshot().byId } } as never)
const statuses = createSnapshotStore(new Map(AGENTS.filter(agent => agent.waiting).map(agent => [agent.id, { running: true, pendingInteraction: { kind: 'approval', key: 'k', sessionId: agent.id }, completionUnread: false }])))

const t = makeTranslate(en)
const layoutsT = makeTranslate(layoutsEn)
// The catalog component reads its own dictionary; the entry points read Multiview's.
const subagentT = makeTranslate(subagentEn)
const injected: EntryInjected = { multiview: store, layoutsT }
const useSessions = <S,>(select: (state: ReturnType<typeof list.getSnapshot>) => S): S => useSyncExternalStore(listener => list.subscribe(listener), () => select(list.getSnapshot()))
const useSessionStatus = <S,>(select: (state: ReturnType<typeof statuses.getSnapshot>) => S): S => useSyncExternalStore(listener => statuses.subscribe(listener), () => select(statuses.getSnapshot()))
const useSession = <S,>(select: (state: { subagent: null }) => S): S => select({ subagent: null })
const unused = (): never => { throw new Error('the picture fixture provides no such slot source') }

/** The row slots as the real registrations fill them: the monogram, the state words and the pin. */
function renderSlot(key: string, owner: { sessionId: SessionId; label: string }): React.ReactNode {
  if (key === 'conversation.session.header.actions.subagent.row.lead') {
    const agent = AGENTS.find(candidate => candidate.id === owner.sessionId)
    return <span className={css.mono} style={{ background: agent?.colour ?? '#64748b' }}>{agent?.mono ?? 'A'}</span>
  }
  if (key === 'conversation.session.header.actions.subagent.row.trail') {
    return <PinButton {...{ sessionId: owner.sessionId, label: owner.label, useSessions, t, ...injected } as never} />
  }
  if (key === 'conversation.session.header.actions.subagent.header') {
    return <Header {...{ sessionId: CHAT, useSessions, t, ...injected } as never} />
  }
  if (key === 'conversation.session.header.actions.subagent.footer') {
    return <Footer {...{ sessionId: CHAT, useSessions, t, ...injected } as never} />
  }
  return null
}

const props = {
  sessionId: CHAT,
  useSessions,
  useSessionStatus,
  useSession,
  useFooterAvailable: <T,>(select: (available: boolean) => T): T => select(true),
  useHeaderAvailable: <T,>(select: (available: boolean) => T): T => select(true),
  useRowSlotsAvailable: <T,>(select: (available: boolean) => T): T => select(true),
  // The catalog action reads the team projection to decide whether the shared-task heading shows; this fixture has none.
  useProjection: <T,>(_key: string, select: (value: undefined) => T): T => select(undefined),
  usePanelInfo: unused,
  useSessionRetainInfo: unused,
  useWorkspaces: unused,
  useResource: unused,
  ...allowAllAccess,
  useContextMenu: contextMenuHook(),
  useConversation: unused,
  useInput: unused,
  useChat: unused,
  useTrajectory: unused,
  inputActions: {
    insertQuote: () => false, captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused,
  },
  openChild: () => {},
  openChildAside: () => {},
  refreshProjection: () => {},
  prepareCatalog: async () => {},
  renderSlot: (key: string, owner: { sessionId: SessionId; label: string }) => renderSlot(key, owner),
  t: subagentT,
} satisfies SubagentCatalogActionProps

function Page() {
  return (
    <div className={css.page}>
      <header className={css.header}>
        <span className={css.title}>Refactor billing service</span>
        <span className={css.action}>
          <button type="button" className={css.trigger} data-open aria-hidden tabIndex={-1}>{AGENTS.length} subagents</button>
        </span>
      </header>
      <SubagentCatalogAction {...props} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
