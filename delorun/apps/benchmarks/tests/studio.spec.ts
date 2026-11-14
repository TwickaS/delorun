import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { corpusModules } from '../src/fixtures/data.ts'
import type { BenchRoot } from '../src/harness/roots.ts'
import {
  appendProfileRows, initScript, INPUT_GLOBAL, LOOKS, NOTICE_KEY, ONBOARDING_DONE_ROW, ONBOARDING_STEPS, onboardingPresses, onboardingStepItem, probeCounts,
  probeDone, probeFailure, probes, RESET_INPUT, SETTINGS_BUTTON, STOCK_LOOK_ROW, STUDIO_ITEMS, STUDIO_SKIPPED, studioParameters, studioSuite, workspacePlan,
  workspaceStore, workspaceUuid, writeWorkspaces, type Probe,
} from '../src/suites/studio/index.ts'

/** Upstream's corpus functions. */
const corpus = await corpusModules()

const made: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, INPUT_GLOBAL)
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/**
 * A throwaway root with its home and Delorun home.
 * @returns the root.
 */
function tempRoot(): BenchRoot {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-bench-studio-spec-')))
  made.push(path)
  const home = join(path, 'home')
  mkdirSync(join(home, '.delorun', 'profiles', 'default'), { recursive: true })
  return { path, home, delorunHome: join(home, '.delorun'), tmp: join(path, 'tmp'), dispose() {} }
}

/** A stand-in element: rendered or not, with a text. */
interface FakeElement {
  readonly rendered: boolean
  readonly textContent: string | null
}

/**
 * Put a stand-in document into the global scope: each selector matches the given elements.
 * @param matches - the elements per selector.
 */
function fakeDocument(matches: Readonly<Record<string, readonly FakeElement[]>>): void {
  const element = (fake: FakeElement): { getClientRects(): readonly object[], textContent: string | null } => ({
    getClientRects: () => fake.rendered ? [{}] : [],
    textContent: fake.textContent,
  })
  vi.stubGlobal('document', {
    querySelectorAll: (selector: string) => (matches[selector] ?? []).map(element),
    querySelector: (selector: string) => {
      const first = matches[selector]?.[0]
      return first === undefined ? null : element(first)
    },
  })
}

const SHOWN: FakeElement = { rendered: true, textContent: 'text' }
const HIDDEN: FakeElement = { rendered: false, textContent: 'text' }

describe('the items and first-run steps', () => {
  it('declares an item for every known first-run step', () => {
    for (const item of Object.values(ONBOARDING_STEPS)) expect(Object.keys(STUDIO_ITEMS)).toContain(item)
  })

  it('names the item of a step by its title and refuses an unknown step', () => {
    expect(onboardingStepItem(' Language and look\n')).toBe('onboarding:look')
    expect(onboardingStepItem('Start')).toBe('onboarding:start')
    expect(() => onboardingStepItem('Billing')).toThrow('does not know: "Billing"')
  })

  it('walks Delorun\'s step list to Start a chat, and the stock look\'s notice with one Continue', () => {
    expect(onboardingPresses(4)).toEqual([
      { button: 'Continue', reaches: 1 }, { button: 'Continue', reaches: 2 }, { button: 'Continue', reaches: 3 }, { button: 'Start a chat', reaches: 'closed' },
    ])
    expect(onboardingPresses(0)).toEqual([{ button: 'Continue', reaches: 'closed' }])
  })

  it('records the workload of both homes', () => {
    expect(studioParameters(20, workspacePlan(20, corpus), 11, workspacePlan(11, corpus))).toEqual({
      chatsFew: 20, workspacesFew: workspacePlan(20, corpus).workspaces.length, chatsMany: 11, workspacesMany: workspacePlan(11, corpus).workspaces.length, longChatTurns: 2181, browser: 'chromium headless',
    })
  })

  it('names every scenario and skip', () => {
    expect(studioSuite.id).toBe('studio')
    expect(studioSuite.items).toBe(STUDIO_ITEMS)
    expect(studioSuite.scenarios.map(scenario => scenario.id)).toEqual(['delorun', 'stock'])
    expect(STUDIO_SKIPPED.every(skip => skip.reason.length > 0)).toBe(true)
  })
})

describe('the workspaces of a chat set', () => {
  it('gives each workspace a fixed version 4 UUID', () => {
    expect(workspaceUuid(0)).toBe('00000000-0000-4000-8000-000000000000')
    expect(workspaceUuid(26)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-00000000001a$/u)
  })

  it('puts the shortest and the longest chat in workspaces of their own, first, and every chat in one workspace', () => {
    const plan = workspacePlan(20, corpus)
    expect(plan.workspaces.slice(0, 2).map(workspace => workspace.key)).toEqual(['short', 'long'])
    expect(plan.workspaces[0]!.sessionIds).toEqual(['bench-00000'])
    expect(plan.shortChat).toEqual({ id: 'bench-00000', workspace: plan.workspaces[0]!.id })
    expect(plan.longChat).toEqual({ id: 'bench-00019', workspace: plan.workspaces[1]!.id, turns: 2181 })
    expect(plan.workspaces[1]!.sessionIds).toEqual(['bench-00019'])
    const all = plan.workspaces.flatMap(workspace => workspace.sessionIds)
    expect(new Set(all).size).toBe(20)
    expect(plan.topLevelChats).toBe(Array.from({ length: 20 }, (_, rank) => rank).filter(rank => !corpus.subagentRank(rank)).length)
    expect(plan.defaultWorkspace).toBe(plan.workspaces[2]!.id)
    expect(plan.workspaces.slice(2).every(workspace => workspace.key.startsWith('project-'))).toBe(true)
  })

  it('keeps a subagent\'s chat with its parent and orders chats and projects newest first', () => {
    const plan = workspacePlan(11, corpus)
    expect(plan.longChat.id).toBe('bench-00010')
    const holder = plan.workspaces.find(workspace => workspace.sessionIds.includes('bench-00005'))!
    expect(holder.sessionIds).toContain('bench-00004')
    for (const workspace of plan.workspaces) expect(workspace.newestAt).toBeGreaterThan(0)
    const projects = plan.workspaces.slice(2)
    for (let index = 1; index < projects.length; index++) expect(projects[index - 1]!.newestAt).toBeGreaterThanOrEqual(projects[index]!.newestAt)
  })

  it('opens new chats in the first measured workspace when no other workspace exists', () => {
    const plan = workspacePlan(2, corpus)
    expect(plan.workspaces.map(workspace => workspace.key)).toEqual(['short', 'long'])
    expect(plan.defaultWorkspace).toBe(plan.workspaces[0]!.id)
  })

  it('refuses a set with fewer than two chats to open', () => {
    expect(() => workspacePlan(1, corpus)).toThrow('fewer than two chats')
  })

  it('writes the registry\'s stored file with each workspace\'s directory', () => {
    const plan = workspacePlan(20, corpus)
    const paths = new Map(plan.workspaces.map(workspace => [workspace.key, `/w/${workspace.key}`]))
    const stored = JSON.parse(workspaceStore(plan, paths)) as {
      unit: unknown
      global: { initialized: boolean, defaultWorkspaceId: string, workspaceIds: string[], archivedSessionIds: string[], pinnedSessionIds: string[] }
      tables: { workspaces: Record<string, { path: string, title: string, sessionIds: string[], createdAt: string, updatedAt: string }> }
    }
    expect(stored.unit).toEqual({ name: 'workspace', version: 2 })
    expect(stored.global).toEqual({ initialized: true, defaultWorkspaceId: plan.defaultWorkspace, workspaceIds: plan.workspaces.map(workspace => workspace.id), archivedSessionIds: [], pinnedSessionIds: [] })
    const short = stored.tables.workspaces[plan.shortChat.workspace]!
    expect(short).toEqual({ path: '/w/short', title: 'short', sessionIds: ['bench-00000'], createdAt: new Date(plan.workspaces[0]!.newestAt).toISOString(), updatedAt: short.createdAt })
  })

  it('creates each workspace\'s directory and the stored file in a home', () => {
    const root = tempRoot()
    const plan = workspacePlan(20, corpus)
    writeWorkspaces(root, plan)
    for (const workspace of plan.workspaces) expect(statSync(join(root.home, 'workspaces', workspace.key)).isDirectory()).toBe(true)
    const stored = JSON.parse(readFileSync(join(root.delorunHome, 'storages', 'workspace.json'), 'utf8')) as { tables: { workspaces: Record<string, { path: string }> } }
    expect(stored.tables.workspaces[plan.longChat.workspace]!.path).toBe(join(root.home, 'workspaces', 'long'))
  })
})

describe('the profile rows', () => {
  it('appends rows to the profile\'s own patch and leaves it alone for none', () => {
    const root = tempRoot()
    const patch = join(root.delorunHome, 'profiles', 'default', 'cordis.patch.yml')
    appendProfileRows(root.delorunHome, '')
    expect(existsSync(patch)).toBe(false)
    writeFileSync(patch, '- id: webserver\n  config:\n    port: 0\n')
    appendProfileRows(root.delorunHome, `${STOCK_LOOK_ROW}${ONBOARDING_DONE_ROW}`)
    expect(readFileSync(patch, 'utf8')).toBe('- id: webserver\n  config:\n    port: 0\n- id: delorun-theme\n  config:\n    studioAdditions: false\n- id: delorun-onboarding\n  config:\n    done: true\n')
  })
})

describe('the looks', () => {
  const plan = workspacePlan(20, corpus)
  const [delorun, stock] = LOOKS as [typeof LOOKS[0], typeof LOOKS[0]]

  it('keeps the shipped composition for Delorun and switches the look off for stock', () => {
    expect(delorun.profileRows).toBe('')
    expect(stock.profileRows).toBe(STOCK_LOOK_ROW)
  })

  it('counts Delorun\'s chat cards and upstream\'s workspace groups', () => {
    expect(delorun.sidebarEntries(plan)).toBe(plan.topLevelChats)
    expect(stock.sidebarEntries(plan)).toBe(plan.workspaces.length)
  })

  it('finds a chat\'s row, and unfolds its workspace first only with the stock look', () => {
    expect(delorun.chatRow('bench-00000')).toBe('[data-sidebar-row="bench-00000"]')
    expect(delorun.reveal('w')).toBeUndefined()
    expect(stock.chatRow('bench-00000')).toBe('[data-row-key="session:bench-00000"]')
    expect(stock.reveal('w')).toBe('[data-row-key="workspace:w"]')
  })

  it('builds each probe from the look and the home', () => {
    const built = probes(stock, plan)
    expect(built.boot).toEqual({ afterInput: false, present: [{ selector: '#root', min: 1 }, { selector: stock.sidebarEntry, min: 1 }], absent: ['[data-dsh-boot]', '#root[inert]'] })
    expect(built.sidebar.present).toEqual([{ selector: stock.sidebarEntry, min: plan.workspaces.length }])
    expect(built.noticeShown.afterInput).toBe(false)
    expect(built.dialogClosed.absent).toContain('#root[inert]')
    expect(built.settings.present[0]!.selector).toContain('data-shortcut-modal="settings"')
    expect(built.step(2).present[0]!.selector).toBe('[role="dialog"] li[aria-current="step"]:nth-child(3)')
    expect(built.chat('bench-00019')).toEqual({
      afterInput: true,
      present: [{ selector: '[data-conversation-session="bench-00019"] [data-chat-flow-kind]', min: 1 }],
      absent: [],
      withoutText: { selector: '[data-conversation-session="bench-00019"]', text: 'Loading history…' },
    })
    expect(SETTINGS_BUTTON).toContain('aria-label="Settings"')
  })
})

describe('the page scripts', () => {
  it('records trusted pointer input and acknowledges the notice when asked', () => {
    const listeners: ((event: { isTrusted: boolean }) => void)[] = []
    const stored = new Map<string, string>()
    vi.stubGlobal('addEventListener', (type: string, listener: (event: { isTrusted: boolean }) => void, capture: boolean) => {
      expect([type, capture]).toEqual(['pointerdown', true])
      listeners.push(listener)
    })
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => { stored.set(key, value) } })
    vi.spyOn(performance, 'now').mockReturnValue(42)
    new Function(initScript(true))()
    expect(stored.get(NOTICE_KEY)).toBe('1')
    listeners[0]!({ isTrusted: false })
    expect(Reflect.get(globalThis, INPUT_GLOBAL)).toBeUndefined()
    listeners[0]!({ isTrusted: true })
    expect(Reflect.get(globalThis, INPUT_GLOBAL)).toBe(42)
    new Function(RESET_INPUT)()
    expect(Reflect.get(globalThis, INPUT_GLOBAL)).toBeUndefined()
  })

  it('leaves the notice owed when not asked, and tolerates a document without storage', () => {
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('opaque origin') } })
    expect(initScript(false)).not.toContain(NOTICE_KEY)
    expect(() => { new Function(initScript(true))() }).not.toThrow()
  })
})

describe('the in-page probe', () => {
  const probe: Probe = { afterInput: true, present: [{ selector: '.row', min: 2 }], absent: ['.busy'], withoutText: { selector: '.chat', text: 'Loading' } }

  it('waits for an input when the item starts at one', () => {
    fakeDocument({ '.row': [SHOWN, SHOWN], '.chat': [SHOWN] })
    expect(probeDone(probe)).toBe(false)
  })

  it('times from the input to the frame that shows the completion', () => {
    fakeDocument({ '.row': [SHOWN, SHOWN, HIDDEN], '.chat': [SHOWN] })
    Reflect.set(globalThis, INPUT_GLOBAL, 100)
    vi.spyOn(performance, 'now').mockReturnValue(350)
    expect(probeDone(probe)).toEqual({ elapsed: 250 })
  })

  it('times from navigation start when the item starts there', () => {
    fakeDocument({ '.row': [SHOWN, SHOWN], '.chat': [SHOWN] })
    vi.spyOn(performance, 'now').mockReturnValue(900)
    expect(probeDone({ ...probe, afterInput: false })).toEqual({ elapsed: 900 })
    expect(probeDone({ afterInput: false, present: [], absent: [] })).toEqual({ elapsed: 900 })
  })

  it('is not complete while too few matches are rendered, a match is absent, or the text shows', () => {
    Reflect.set(globalThis, INPUT_GLOBAL, 100)
    fakeDocument({ '.row': [SHOWN, HIDDEN], '.chat': [SHOWN] })
    expect(probeDone(probe)).toBe(false)
    fakeDocument({ '.row': [SHOWN, SHOWN], '.busy': [HIDDEN], '.chat': [SHOWN] })
    expect(probeDone(probe)).toBe(false)
    fakeDocument({ '.row': [SHOWN, SHOWN], '.chat': [{ rendered: true, textContent: 'Loading…' }] })
    expect(probeDone(probe)).toBe(false)
    fakeDocument({ '.row': [SHOWN, SHOWN] })
    expect(probeDone(probe)).toBe(false)
    fakeDocument({ '.row': [SHOWN, SHOWN], '.chat': [{ rendered: true, textContent: null }] })
    expect(probeDone(probe)).not.toBe(false)
  })

  it('reports what the page shows of each selector', () => {
    fakeDocument({ '.row': [SHOWN, HIDDEN], '.busy': [HIDDEN] })
    expect(probeCounts(probe)).toEqual(['.row: 2 matched, 1 rendered', '.busy: 1 matched, 0 rendered'])
  })

  it('names the item, what it waits for and what the page shows when it times out', () => {
    const failure = probeFailure('chat:long', probe, ['.row: 0 matched, 0 rendered'], new Error('Timeout 60000ms exceeded.\nCall log'))
    expect(failure.message).toBe('studio item chat:long did not complete (Timeout 60000ms exceeded.); it waits for at least 2 of .row, no .busy, no "Loading" in .chat; the page shows .row: 0 matched, 0 rendered')
    expect(probeFailure('settings', { afterInput: true, present: [], absent: [] }, undefined, 'closed').message)
      .toBe('studio item settings did not complete (closed); it waits for ; the page shows nothing it could report')
  })
})
