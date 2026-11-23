/**
 * A page for the entry points' screenshots: the real pin button, popover footer and Multiview toggle over the real colour
 * tokens, in a header and an agents popover whose chrome and rows stand in for the upstream catalog component.
 */
import '../../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import { ICON_SYMBOLS } from '@deepseek-ai/dsh-client-ui-primitives'
import { createRoot } from 'react-dom/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { useSyncExternalStore } from 'react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { DEFAULT_MULTIVIEW_SETTINGS } from '../../../src/config.ts'
import { Footer, MultiviewToggle, PinButton, type EntryInjected } from '../../../src/entry/Entry.tsx'
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
const pinnedCount = Number(params.get('pins') ?? '3')
const maxPanes = Number(params.get('max') ?? '6')
const shown = params.get('open') === '1'
const popover = params.get('popover') !== '0'

const sid = SessionId
const CHAT = sid('chat')
const AGENTS = [
  { id: sid('a1'), name: 'Reviewer', words: 'Claude Code · Working', mono: 'CC', colour: '#7c5cff', running: true },
  { id: sid('a2'), name: 'Migration writer', words: 'Codex · Waiting for you', mono: 'CX', colour: '#0f9d8a', running: true, waiting: true },
  { id: sid('a3'), name: 'Test runner', words: 'Subagent · Working · 1m 12s', mono: 'T', colour: '#3b82f6', running: true },
  { id: sid('a4'), name: 'Docs pass', words: 'Teammate · Working', mono: 'D', colour: '#e0a100', running: true },
  { id: sid('a5'), name: 'Type check', words: 'Subagent · Done in 48s', mono: 'T', colour: '#64748b', running: false },
  { id: sid('a6'), name: 'Changelog', words: 'Subagent · Done in 21s', mono: 'C', colour: '#64748b', running: false },
]

const store = new MultiviewStore({
  settings: createSnapshotStore({ ...DEFAULT_MULTIVIEW_SETTINGS, maxPanes }),
  persistence: { load: () => undefined, save: () => {} },
  windowArea: () => ({ width: 4000, height: 3000 }),
})
store.pinAll(CHAT, AGENTS.slice(0, pinnedCount).map(agent => agent.id))
if (shown) { store.applyPreset(CHAT, 'main-column'); store.open(CHAT) }

const list = createSnapshotStore({
  ids: [], phase: 'ready', projectionsBySession: {},
  byId: Object.fromEntries(AGENTS.map(agent => [agent.id, { id: agent.id, displayTitle: agent.name, running: agent.running, retainedBy: {}, blank: false, updatedAt: 0, origin: 'subagent', parentId: CHAT }])),
})
const projection = { values: { subagentCatalog: AGENTS.map(agent => ({ id: agent.id, createdAt: 0, mode: 'subagent' })) }, state: 'ready', error: null }
list.set({ ...list.getSnapshot(), projectionsBySession: { [CHAT]: projection } } as never)
list.set({ ...list.getSnapshot(), byId: { [CHAT]: { id: CHAT, displayTitle: 'Refactor billing service', running: true, retainedBy: { mainView: 1 }, blank: false, updatedAt: 0 }, ...list.getSnapshot().byId } } as never)
const statuses = createSnapshotStore(new Map(AGENTS.filter(agent => agent.waiting).map(agent => [agent.id, { running: true, pendingInteraction: { kind: 'approval', key: 'k', sessionId: agent.id }, completionUnread: false }])))

const t = (key: keyof typeof en, vars: Record<string, string> = {}): string =>
  Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), en[key])
const layoutsT = (key: keyof typeof layoutsEn, vars: Record<string, string> = {}): string =>
  Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), layoutsEn[key])
const injected: EntryInjected = { multiview: store, layoutsT }
const useSessions = <S,>(select: (state: ReturnType<typeof list.getSnapshot>) => S): S => useSyncExternalStore(listener => list.subscribe(listener), () => select(list.getSnapshot()))
const useSessionStatus = <S,>(select: (state: ReturnType<typeof statuses.getSnapshot>) => S): S => useSyncExternalStore(listener => statuses.subscribe(listener), () => select(statuses.getSnapshot()))
const useSession = <S,>(select: (state: { subagent: null }) => S): S => select({ subagent: null })

function Page() {
  const props = { sessionId: CHAT, useSessions, useSessionStatus, useSession, t, ...injected }
  return (
    <div className={css.page}>
      <header className={css.header}>
        <span className={css.title}>Refactor billing service</span>
        <span className={css.action}>
          <button type="button" className={css.trigger} data-open>{AGENTS.length} subagents</button>
          <MultiviewToggle {...props as never} />
        </span>
      </header>
      <div className={css.popover} role="tree" aria-label="Subagents" hidden={!popover}>
        {AGENTS.map(agent => (
          <div key={agent.id} className={css.row} role="treeitem" aria-selected={false}>
            <span className={css.mono} style={{ background: agent.colour }}>{agent.mono}</span>
            <span className={css.text}>
              <span className={css.name}>{agent.name}</span>
              <span className={css.words} data-waiting={agent.waiting || undefined}>{agent.words}</span>
            </span>
            <PinButton {...{ sessionId: agent.id, label: agent.name, useSessions, t, ...injected } as never} />
          </div>
        ))}
        <Footer {...props as never} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
