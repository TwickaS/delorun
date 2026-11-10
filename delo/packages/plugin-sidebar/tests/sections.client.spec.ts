import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import {
  badgeColor, chatStatus, folderDot, inScope, orderPinned, searchChats, shouldRecede, sidebarChats, sidebarDropTarget, sidebarDropVerb,
  sidebarFolders, sidebarItemId, sidebarSections, waitsOnPerson, withAutoSettled, workspaceInitials, type ChatStatusFacts, type SidebarChat, type SidebarListItem,
} from '../src/client/sections.ts'

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, fields: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, cwd: '/workspace/api', updatedAt: 100, running: false, blank: false, retainedBy: {}, ...fields,
})
const listOf = (...chats: SessionSummary[]): SessionListState => ({
  ids: chats.map(each => each.id), byId: Object.fromEntries(chats.map(each => [each.id, each])), phase: 'ready', projectionsBySession: {},
})
const workspace = (id: string, title: string, sessionIds: string[], path = `/workspace/${title}`): WorkspaceView => ({
  workspaceId: wid(id), title, path, sessionIds: sessionIds.map(sid), createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
})
const facts = (fields: Partial<ChatStatusFacts>): ChatStatusFacts => ({ running: false, pendingInteraction: undefined, completionUnread: false, ...fields })
const chatOf = (id: string, fields: Partial<SidebarChat> = {}): SidebarChat => ({
  id: sid(id), title: id, updatedAt: 100, createdAt: 100, promptAt: undefined, workspace: null, pinned: false, status: 'ready', unread: false,
  model: null, preset: null, ...fields,
})

describe('a chat\'s status', () => {
  it('puts what the chat waits on first, then working, then ready', () => {
    expect(chatStatus(facts({ pendingInteraction: { kind: 'approval' }, running: true }), true)).toBe('approval')
    expect(chatStatus(facts({ pendingInteraction: { kind: 'question' } }), false)).toBe('question')
    expect(chatStatus(facts({ pendingInteraction: { kind: 'plan-review' } }), false)).toBe('plan')
    expect(chatStatus(facts({ running: true }), false)).toBe('working')
    expect(chatStatus(facts({ running: undefined }), true)).toBe('working')
    expect(chatStatus(undefined, false)).toBe('ready')
    expect([waitsOnPerson('plan'), waitsOnPerson('working')]).toEqual([true, false])
  })

  it('recedes a working or quiet chat, never an open one or one asking a question', () => {
    const base = { unread: false, woke: false, current: false }
    expect(shouldRecede({ ...base, status: 'working' })).toBe(true)
    expect(shouldRecede({ ...base, status: 'ready' })).toBe(true)
    expect(shouldRecede({ ...base, status: 'ready', unread: true })).toBe(false)
    expect(shouldRecede({ ...base, status: 'approval', woke: true })).toBe(false)
    expect(shouldRecede({ ...base, status: 'question' })).toBe(false)
    expect(shouldRecede({ ...base, status: 'working', current: true })).toBe(false)
  })
})

describe('the chats the sidebar lists', () => {
  it('leaves out subagents, blank and archived chats, and reads each chat\'s workspace, model, mode and prompt', () => {
    const list = listOf(
      summary('a', {
        createdAt: 40,
        projectionValues: {
          sessionListMetadata: { lastPromptAt: 90 }, modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-v4' } }, agentPreset: 'ptc',
        },
      } as Partial<SessionSummary>),
      summary('b'), summary('sub', { origin: 'subagent' }), summary('blank', { blank: true }), summary('old'),
    )
    const api = workspace('w1', 'api', ['a'])
    const chats = sidebarChats(list, new Map([[sid('a'), facts({ completionUnread: true })]]), [api], [sid('b')], [sid('old')])
    expect(chats.map(chat => chat.id)).toEqual([sid('a'), sid('b')])
    expect([chats[0]?.createdAt, chats[1]?.createdAt]).toEqual([40, 100])
    expect(chats[0]).toMatchObject({ workspace: api, model: { provider: 'deepseek', model: 'deepseek-v4' }, preset: 'ptc', promptAt: 90, unread: true })
    expect(chats[1]).toMatchObject({ workspace: null, model: null, preset: null, promptAt: undefined, pinned: true })
  })

  it('sorts chats into Pinned, the cards and the shelves', () => {
    const chats = [
      chatOf('pinned2', { pinned: true, updatedAt: 500 }), chatOf('pinned1', { pinned: true, updatedAt: 400 }),
      chatOf('active', { updatedAt: 300 }), chatOf('working', { status: 'working', updatedAt: 250 }),
      chatOf('snoozed', { updatedAt: 200 }), chatOf('settledOld', { updatedAt: 150 }), chatOf('settledNew', { updatedAt: 120 }),
      chatOf('asking', { status: 'question', updatedAt: 110 }), chatOf('promptedSince', { updatedAt: 900 }),
    ]
    const shelving = {
      snoozed: new Map([[sid('snoozed'), 210], [sid('asking'), 210]]),
      settled: new Map([[sid('settledOld'), 160], [sid('settledNew'), 170], [sid('promptedSince'), 800]]),
    }
    const sections = sidebarSections(chats, shelving, [sid('pinned1'), sid('pinned2')])
    expect(Object.fromEntries(Object.entries(sections).map(([name, rows]) => [name, rows.map(row => row.id)]))).toEqual({
      pinned: ['pinned1', 'pinned2'], active: ['promptedSince', 'active', 'asking'], working: ['working'], snoozed: ['snoozed'],
      settled: ['settledNew', 'settledOld'],
    })
    expect(sidebarSections(chats, shelving, [], false).active.map(row => row.id)).toContain(sid('working'))
    const born = [chatOf('old', { createdAt: 1, updatedAt: 900 }), chatOf('new', { createdAt: 5, updatedAt: 10 })]
    const none = { snoozed: new Map(), settled: new Map() }
    expect(sidebarSections(born, none, [], true, 'created').active.map(row => row.id)).toEqual([sid('new'), sid('old')])
    expect(sidebarSections(born, none, []).active.map(row => row.id)).toEqual([sid('old'), sid('new')])
  })

  it('gives a chat listed by two workspaces to the first', () => {
    const first = workspace('w1', 'first', ['a'])
    const second = workspace('w2', 'second', ['a'])
    expect(sidebarChats(listOf(summary('a')), new Map(), [first, second], [], [])[0]?.workspace).toBe(first)
  })

  it('searches titles and workspaces for every word, and keeps the chats of the filtered workspaces', () => {
    const api = workspace('w1', 'api', [])
    const chats = [chatOf('Fix login', { workspace: api, updatedAt: 1 }), chatOf('Login page', { updatedAt: 2 }), chatOf('Other')]
    expect(searchChats(chats, 'login').map(chat => chat.title)).toEqual(['Login page', 'Fix login'])
    expect(searchChats(chats, 'API fix').map(chat => chat.title)).toEqual(['Fix login'])
    expect(searchChats(chats, '  ')).toEqual([])
    expect(inScope(chats, new Set([wid('w1')])).map(chat => chat.title)).toEqual(['Fix login'])
    expect(inScope(chats, new Set())).toHaveLength(3)
  })

  it('gives each workspace initials and a colour by its place', () => {
    expect([workspaceInitials('delo run'), workspaceInitials('api'), workspaceInitials('——'), workspaceInitials('my-site')]).toEqual(['DR', 'AP', '', 'MS'])
    const all = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => workspace(id, id, [], `/w/${String(index)}`))
    expect(all.map(each => badgeColor(all, each.workspaceId))).toEqual(['blue', 'green', 'amber', 'violet', 'red', 'blue'])
    expect(badgeColor(all, wid('missing'))).toBe('blue')
  })

  it('groups chats into a folder per workspace in scope, then the chats outside every workspace', () => {
    const api = workspace('w1', 'api', [])
    const site = workspace('w2', 'site', [])
    const chats = [chatOf('a', { workspace: api }), chatOf('loose')]
    expect(sidebarFolders(chats, [api, site], new Set()).map(folder => [folder.workspace?.title ?? null, folder.chats.length])).toEqual([['api', 1], ['site', 0], [null, 1]])
    expect(sidebarFolders([chats[0] ?? chatOf('x')], [api, site], new Set([wid('w2')])).map(folder => folder.workspace?.title)).toEqual(['site'])
    expect([
      folderDot([chatOf('a', { status: 'working' }), chatOf('b', { status: 'approval' })]),
      folderDot([chatOf('a', { status: 'working' }), chatOf('b', { unread: true })]),
      folderDot([chatOf('a', { unread: true })]),
      folderDot([chatOf('a')]),
    ]).toEqual(['waiting', 'working', 'done', null])
  })
})

describe('auto-settle', () => {
  it('adds a chat idle for the days since its latest change or its return, and keeps the map when nothing is added', () => {
    const DAY = 86_400_000
    const chats = [chatOf('idle', { updatedAt: 0 }), chatOf('kept', { updatedAt: 0 }), chatOf('fresh', { updatedAt: 9 * DAY }), chatOf('done', { updatedAt: 0 })]
    const settled = new Map([[sid('done'), 5]])
    const merged = withAutoSettled(chats, settled, new Map([[sid('kept'), 8 * DAY]]), 3, 10 * DAY)
    expect([...merged]).toEqual([[sid('done'), 5], [sid('idle'), 3 * DAY]])
    expect(withAutoSettled(chats, settled, new Map(), 0, 10 * DAY)).toBe(settled)
    expect(withAutoSettled([chats[2] ?? chatOf('x')], settled, new Map(), 3, 10 * DAY)).toBe(settled)
  })
})

describe('dragging, after T3 Code\'s drop rules', () => {
  const items: SidebarListItem[] = [
    { kind: 'chat', id: sid('p1'), section: 'pinned' }, { kind: 'chat', id: sid('p2'), section: 'pinned' },
    { kind: 'marker', marker: 'pinned-divider' },
    { kind: 'chat', id: sid('a1'), section: 'active' }, { kind: 'chat', id: sid('a2'), section: 'active' },
    { kind: 'marker', marker: 'working-header' }, { kind: 'chat', id: sid('w1'), section: 'working' },
    { kind: 'marker', marker: 'settled-header' }, { kind: 'chat', id: sid('s1'), section: 'settled' },
  ]
  const target = (active: string, over: string) => sidebarDropTarget(items, active, over)

  it('lands a chat in the section of the slot it is dropped on, with the pins\' order', () => {
    expect(target('a1', 'p1')).toEqual({ section: 'pinned', pinnedOrder: [sid('a1'), sid('p1'), sid('p2')] })
    expect(target('p1', 'p2')).toEqual({ section: 'pinned', pinnedOrder: [sid('p2'), sid('p1')] })
    expect(target('p1', 'a2')?.section).toBe('active')
    expect(target('a1', 's1')?.section).toBe('settled')
    expect(target('a1', sidebarItemId({ kind: 'marker', marker: 'settled-header' }))?.section).toBe('settled')
    expect(target('a1', 'w1')).toBeNull()
    expect(target('missing', 'a1')).toBeNull()
    expect(target(sidebarItemId({ kind: 'marker', marker: 'pinned-divider' }), 'a1')).toBeNull()
  })

  it('names what a drop does, and nothing for one that stays or lands on Working or Snoozed', () => {
    expect([
      sidebarDropVerb('active', 'pinned'), sidebarDropVerb('pinned', 'active'), sidebarDropVerb('active', 'settled'),
      sidebarDropVerb('settled', 'active'), sidebarDropVerb('snoozed', 'active'), sidebarDropVerb('active', 'active'),
      sidebarDropVerb('active', 'working'), sidebarDropVerb('active', null),
    ]).toEqual(['pin', 'unpin', 'settle', 'unsettle', 'wake', null, null, null])
  })

  it('orders the pins as the viewer dragged them, then the rest in pin order', () => {
    expect(orderPinned([sid('a'), sid('b'), sid('c')], [sid('c'), sid('gone'), sid('a')])).toEqual([sid('c'), sid('a'), sid('b')])
  })
})
