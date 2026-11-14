/**
 * The studio suite: how long a person waits on the studio page itself, in a real headless Chromium driven by
 * Playwright on loopback, with Delorun's studio composition and with the stock look, so Delorun's added cost reads as the
 * difference between the two scenarios. Each repetition copies an installed home, writes its workspaces, starts it
 * with `delorun start` through the launcher and opens the studio through the start link the Host printed:
 *
 * - the first-run dialog of a fresh browser, step by step;
 * - a fresh browser's boot to a page that accepts input, and to a complete sidebar, with the small and the large chat set;
 * - opening the shortest and the longest chat from the sidebar and switching between them;
 * - opening Settings.
 *
 * The stock look is the one switch Settings → General → Look writes, the theme row's `studioAdditions: false` in the
 * profile's own patch: every browser half of `@delorun/bundle-studio` unloads and upstream's studio remains, while
 * `@delorun/bundle-local` and every Host half stay as they are. Each item is timed inside the page: from the trusted
 * pointer input that triggers it (or from navigation start) to the first animation frame whose document shows the
 * item's completion ({@link Probe}).
 *
 * @module @delorun/benchmarks/suites/studio
 */
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { corpusModules, type CorpusModules } from '../../fixtures/data.ts'
import { copyHome, PROFILE, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { installedChannel, templateHome } from '../../fixtures/releases.ts'
import { Samples, type ScenarioResult, type Skipped, type SuiteResult } from '../../harness/result.ts'
import { childEnvironment, type BenchRoot } from '../../harness/roots.ts'
import type { SharedFixtures, Suite, SuiteContext } from '../../harness/suite.ts'
import { startForLink } from '../start/index.ts'

/** How long one item may take before the repetition fails. */
const ITEM_TIMEOUT_MS = 60_000

/** How long a boot or the longest chat may take. */
const LONG_TIMEOUT_MS = 180_000

/** The suite's items. */
export const STUDIO_ITEMS: Readonly<Record<string, string>> = {
  'onboarding:shown': 'A fresh browser opening a new home\'s start link, from navigation start to the first-run dialog showing the preview notice',
  'onboarding:look': 'Continue on the preview notice, from the press to Language and look being the current step',
  'onboarding:agents': 'Continue on Language and look, from the press to Agents being the current step',
  'onboarding:plugins': 'Continue to Recommended plugins, from the press to it being the current step',
  'onboarding:reach': 'Continue to Reach, from the press to it being the current step',
  'onboarding:start': 'Continue to Start, from the press to it being the current step',
  'onboarding:done': 'The first-run dialog\'s last button, from the press to the dialog closed and the page accepting input',
  'boot:few': 'A fresh browser opening the studio of the home with the small chat set, from navigation start to the page accepting input: the boot screen gone, no dialog blocking the page and the sidebar\'s first entry shown',
  'sidebar:few': 'The same navigation, to every sidebar entry shown: each chat with the Delorun look, each workspace with the stock look, which folds its workspaces',
  'boot:many': 'As boot:few, with the large chat set and its workspaces',
  'sidebar:many': 'As sidebar:few, with the large chat set and its workspaces',
  'chat:short': 'Opening the shortest chat from its sidebar row, from the press to its messages rendered',
  'chat:long': 'Opening the longest chat from its sidebar row while the shortest is open, from the press to its latest messages rendered',
  'chat:switch-short': 'Back to the shortest chat from its sidebar row, from the press to its messages rendered',
  'chat:switch-long': 'Back to the longest chat from its sidebar row, from the press to its latest messages rendered',
  'settings': 'Settings from the sidebar\'s Settings button, from the press to the dialog\'s first section rendered',
}

/** Delorun's first-run steps by the title the dialog's step list shows, each with the item that times reaching it. */
export const ONBOARDING_STEPS: Readonly<Record<string, string>> = {
  'Language and look': 'onboarding:look',
  'Agents': 'onboarding:agents',
  'Recommended plugins': 'onboarding:plugins',
  'Reach': 'onboarding:reach',
  'Start': 'onboarding:start',
}

/**
 * The item that times reaching a first-run step.
 * @param title - the step's title in the dialog's step list.
 * @returns the item's id.
 * @throws {Error} when the step is not one this suite knows, so a new step is added here before it is measured.
 */
export function onboardingStepItem(title: string): string {
  const item = ONBOARDING_STEPS[title.trim()]
  if (item === undefined) throw new Error(`the first-run dialog shows a step this suite does not know: "${title.trim()}"`)
  return item
}

/** One press in the first-run dialog. */
export interface OnboardingPress {
  /** The button's label. */
  readonly button: string
  /** The position of the step it reaches in the dialog's step list, or `closed` for the press that ends the dialog. */
  readonly reaches: number | 'closed'
}

/**
 * The presses that walk the first-run dialog to its end: Continue to each next step and Start a chat on the last, or
 * with no step list (the stock look's preview notice alone) Continue once.
 * @param steps - the steps in the dialog's step list.
 * @returns the presses, in order.
 */
export function onboardingPresses(steps: number): readonly OnboardingPress[] {
  if (steps === 0) return [{ button: 'Continue', reaches: 'closed' }]
  return Array.from({ length: steps }, (_, position) => position === steps - 1 ? { button: 'Start a chat', reaches: 'closed' as const } : { button: 'Continue', reaches: position + 1 })
}

/** One workspace the suite writes into a home. */
export interface PlannedWorkspace {
  /** Its directory's name under `<home>/workspaces/`, and its title. */
  readonly key: string
  /** Its id. */
  readonly id: string
  /** Its chats, newest first. */
  readonly sessionIds: readonly string[]
  /** Its newest chat's creation time, in epoch milliseconds. */
  readonly newestAt: number
}

/** The workspaces of a home with a synthetic chat set, and the chats the suite opens. */
export interface WorkspacePlan {
  /** The workspaces, in display order. */
  readonly workspaces: readonly PlannedWorkspace[]
  /** The workspace that new chats open in. */
  readonly defaultWorkspace: string
  /** Chats that are not a subagent's. */
  readonly topLevelChats: number
  /** The shortest chat. */
  readonly shortChat: { readonly id: string, readonly workspace: string }
  /** The longest chat that is not a subagent's. */
  readonly longChat: { readonly id: string, readonly workspace: string, readonly turns: number }
}

/**
 * A workspace id: a fixed version 4 UUID per position, so the same plan writes the same bytes.
 * @param index - the workspace's position.
 * @returns the id.
 */
export function workspaceUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

/**
 * The workspaces of a synthetic chat set. Chats are grouped by their stored working directory, as the workspace
 * registry groups a home's chats on its first start, except that the shortest and the longest chat each get a
 * workspace of their own, so each one's row is the only row of its workspace and shows whatever the sidebar folds. A
 * subagent's chat stays with its parent.
 * @param count - the chat set's size.
 * @param corpus - upstream's corpus functions, from `corpusModules`.
 * @returns the plan.
 * @throws {Error} when the set has fewer than two chats that are not a subagent's.
 */
export function workspacePlan(count: number, corpus: CorpusModules): WorkspacePlan {
  const { corpusHeader, corpusSessionId, sessionShape, subagentRank } = corpus
  const topLevel = Array.from({ length: count }, (_, rank) => rank).filter(rank => !subagentRank(rank))
  if (topLevel.length < 2) throw new Error(`a chat set of ${String(count)} has fewer than two chats to open`)
  const shortRank = topLevel[0]!
  const longRank = topLevel[topLevel.length - 1]!
  const groups = new Map<string, number[]>([['short', []], ['long', []]])
  for (let rank = 0; rank < count; rank++) {
    const parent = subagentRank(rank) ? rank - 1 : rank
    const key = parent === shortRank ? 'short' : parent === longRank ? 'long' : basename(corpusHeader(parent, count).cwd!)
    groups.set(key, [...groups.get(key) ?? [], rank])
  }
  const createdAt = (rank: number): number => corpusHeader(rank, count).createdAt
  const sorted = [...groups].map(([key, ranks]) => {
    const newestFirst = [...ranks].sort((a, b) => createdAt(b) - createdAt(a))
    return { key, sessionIds: newestFirst.map(rank => String(corpusSessionId(rank))), newestAt: createdAt(newestFirst[0]!) }
  })
  const measured = sorted.filter(group => group.key === 'short' || group.key === 'long')
  const projects = sorted.filter(group => group.key !== 'short' && group.key !== 'long').sort((a, b) => b.newestAt - a.newestAt || a.key.localeCompare(b.key))
  const workspaces = [...measured, ...projects].map((group, index) => ({ ...group, id: workspaceUuid(index) }))
  const idOf = (key: string): string => workspaces.find(workspace => workspace.key === key)!.id
  return {
    workspaces,
    defaultWorkspace: (projects.length > 0 ? workspaces[2]! : workspaces[0]!).id,
    topLevelChats: topLevel.length,
    shortChat: { id: String(corpusSessionId(shortRank)), workspace: idOf('short') },
    longChat: { id: String(corpusSessionId(longRank)), workspace: idOf('long'), turns: sessionShape(longRank, count).turns },
  }
}

/**
 * The workspace registry's stored file for a plan: `workspace` domain version 2 of the JSON storage backend.
 * @param plan - the plan.
 * @param paths - each workspace's directory by key, resolved.
 * @returns the file's text.
 */
export function workspaceStore(plan: WorkspacePlan, paths: ReadonlyMap<string, string>): string {
  const tables = Object.fromEntries(plan.workspaces.map(workspace => {
    const at = new Date(workspace.newestAt).toISOString()
    return [workspace.id, { path: paths.get(workspace.key), title: workspace.key, sessionIds: workspace.sessionIds, createdAt: at, updatedAt: at }]
  }))
  const global = { initialized: true, defaultWorkspaceId: plan.defaultWorkspace, workspaceIds: plan.workspaces.map(workspace => workspace.id), archivedSessionIds: [], pinnedSessionIds: [] }
  return `${JSON.stringify({ unit: { name: 'workspace', version: 2 }, global, tables: { workspaces: tables } }, undefined, 2)}\n`
}

/**
 * Write a plan's workspaces into a home: a directory per workspace under `<home>/workspaces/` and the registry's file
 * under `<Delorun home>/storages/`.
 * @param root - the root.
 * @param plan - the plan.
 */
export function writeWorkspaces(root: BenchRoot, plan: WorkspacePlan): void {
  const paths = new Map<string, string>()
  for (const workspace of plan.workspaces) {
    const directory = join(root.home, 'workspaces', workspace.key)
    mkdirSync(directory, { recursive: true })
    paths.set(workspace.key, realpathSync(directory))
  }
  mkdirSync(join(root.delorunHome, 'storages'), { recursive: true })
  writeFileSync(join(root.delorunHome, 'storages', 'workspace.json'), workspaceStore(plan, paths))
}

/** The profile patch row Settings → General → Look writes to turn Delorun's look off. */
export const STOCK_LOOK_ROW = '- id: delorun-theme\n  config:\n    studioAdditions: false\n'

/** The profile patch row the first-run dialog's Skip writes. */
export const ONBOARDING_DONE_ROW = '- id: delorun-onboarding\n  config:\n    done: true\n'

/**
 * Append rows to the CLI profile's own patch.
 * @param delorunHome - the Delorun home.
 * @param rows - the rows' text.
 */
export function appendProfileRows(delorunHome: string, rows: string): void {
  if (rows !== '') appendFileSync(join(delorunHome, 'profiles', PROFILE, 'cordis.patch.yml'), rows)
}

/** One selector a completed item shows. */
export interface ProbeMatch {
  /** A CSS selector. */
  readonly selector: string
  /** How many rendered elements it must match at least. */
  readonly min: number
}

/** What the page shows once an item completed. */
export interface Probe {
  /** Whether the item starts at a pointer input; otherwise it starts at navigation start. */
  readonly afterInput: boolean
  /** Each selector must match at least `min` elements with a layout box. */
  readonly present: readonly ProbeMatch[]
  /** No selector may match. */
  readonly absent: readonly string[]
  /** An element whose text must not contain a text, such as a loading notice. */
  readonly withoutText?: { readonly selector: string, readonly text: string }
}

/** The page global where {@link INIT_SCRIPT} records the latest trusted pointer input. */
export const INPUT_GLOBAL = '__delorunBenchInput'

/** The key of Delorun's preview notice acknowledgement in the page's local storage. */
export const NOTICE_KEY = 'delorun.preview-notice'

/**
 * The script that runs in every document before the studio's: it records the time of each trusted pointer input in
 * {@link INPUT_GLOBAL}, and acknowledges Delorun's preview notice when asked, as a browser that saw it before has.
 * @param acknowledgeNotice - whether the browser has acknowledged the preview notice.
 * @returns the script's source.
 */
export function initScript(acknowledgeNotice: boolean): string {
  const notice = acknowledgeNotice ? `try { localStorage.setItem(${JSON.stringify(NOTICE_KEY)}, '1') } catch (_opaque) {}\n` : ''
  return `${notice}addEventListener('pointerdown', function (event) { if (event.isTrusted) globalThis[${JSON.stringify(INPUT_GLOBAL)}] = performance.now() }, true)\n`
}

/** The script that forgets the latest pointer input before an item starts. */
export const RESET_INPUT = `globalThis[${JSON.stringify(INPUT_GLOBAL)}] = undefined`

/**
 * Whether the page shows a probe's completion, run inside the page at each animation frame. Playwright sends the
 * function's source to the page, so it reads only page globals and declares no inner function.
 * @param probe - the probe.
 * @returns the item's time in milliseconds once complete, otherwise `false`.
 */
export function probeDone(probe: Probe): { readonly elapsed: number } | false {
  const input = Reflect.get(globalThis, '__delorunBenchInput') as number | undefined
  if (probe.afterInput && input === undefined) return false
  for (const match of probe.present) {
    const found = document.querySelectorAll(match.selector)
    let rendered = 0
    for (let index = 0; index < found.length; index++) {
      if (found[index]!.getClientRects().length > 0) rendered++
    }
    if (rendered < match.min) return false
  }
  for (const selector of probe.absent) {
    if (document.querySelector(selector) !== null) return false
  }
  if (probe.withoutText !== undefined) {
    const element = document.querySelector(probe.withoutText.selector)
    if (element === null || (element.textContent ?? '').includes(probe.withoutText.text)) return false
  }
  return { elapsed: performance.now() - (probe.afterInput ? input! : 0) }
}

/**
 * What the page shows of a probe's selectors, run inside the page when an item timed out.
 * @param probe - the probe.
 * @returns per selector, the elements it matches and how many have a layout box.
 */
export function probeCounts(probe: Probe): string[] {
  const lines: string[] = []
  for (const selector of [...probe.present.map(match => match.selector), ...probe.absent]) {
    const found = document.querySelectorAll(selector)
    let rendered = 0
    for (let index = 0; index < found.length; index++) {
      if (found[index]!.getClientRects().length > 0) rendered++
    }
    lines.push(`${selector}: ${String(found.length)} matched, ${String(rendered)} rendered`)
  }
  return lines
}

/**
 * The failure of an item whose completion the page did not show in time.
 * @param item - the item.
 * @param probe - its probe.
 * @param counts - what {@link probeCounts} saw, or `undefined` when the page could not be asked.
 * @param cause - the wait's error.
 * @returns the error.
 */
export function probeFailure(item: string, probe: Probe, counts: readonly string[] | undefined, cause: unknown): Error {
  const wanted = [
    ...probe.present.map(match => `at least ${String(match.min)} of ${match.selector}`),
    ...probe.absent.map(selector => `no ${selector}`),
    ...probe.withoutText === undefined ? [] : [`no "${probe.withoutText.text}" in ${probe.withoutText.selector}`],
  ]
  const reason = cause instanceof Error ? cause.message.split('\n')[0]! : String(cause)
  return new Error(`studio item ${item} did not complete (${reason}); it waits for ${wanted.join(', ')}; the page shows ${counts === undefined ? 'nothing it could report' : counts.join('; ')}`, { cause })
}

/** The page's root element, which a blocking dialog makes inert. */
const ROOT = '#root'

/** The studio's boot screen, removed once the application renders. */
const BOOT_SCREEN = '[data-dsh-boot]'

/** The Settings button: the sidebar foot's with the Delorun look, upstream's launcher with the stock look. */
export const SETTINGS_BUTTON = 'button[aria-label="Settings"][aria-haspopup="dialog"]'

/** One look the suite measures in: a scenario. */
export interface Look {
  /** The scenario's id. */
  readonly id: 'delorun' | 'stock'
  /** What it is. */
  readonly description: string
  /** Rows appended to the CLI profile's patch before the home starts. */
  readonly profileRows: string
  /** The sidebar's entries: Delorun's chat cards, or upstream's workspace groups. */
  readonly sidebarEntry: string
  /**
   * How many entries the sidebar shows once complete.
   * @param plan - the home's workspaces.
   * @returns the count.
   */
  sidebarEntries(plan: WorkspacePlan): number
  /**
   * A chat's sidebar row.
   * @param id - the chat.
   * @returns its selector.
   */
  chatRow(id: string): string
  /**
   * The row to press first so a chat's row shows, before the item starts.
   * @param workspace - the chat's workspace.
   * @returns its selector, or `undefined` when chat rows always show.
   */
  reveal(workspace: string): string | undefined
}

/** The two looks. */
export const LOOKS: readonly Look[] = [
  {
    id: 'delorun',
    description: 'Delorun\'s composition: the studio bundle\'s theme, settings layout, chat states, sidebar and first-run dialog on upstream\'s studio',
    profileRows: '',
    sidebarEntry: '[data-sidebar-row]',
    sidebarEntries: plan => plan.topLevelChats,
    chatRow: id => `[data-sidebar-row="${id}"]`,
    reveal: () => undefined,
  },
  {
    id: 'stock',
    description: 'The same home with the stock look, the Settings → General → Look switch that unloads every browser half of the studio bundle',
    profileRows: STOCK_LOOK_ROW,
    sidebarEntry: '[data-row-key^="workspace:"]',
    sidebarEntries: plan => plan.workspaces.length,
    chatRow: id => `[data-row-key="session:${id}"]`,
    reveal: workspace => `[data-row-key="workspace:${workspace}"]`,
  },
]

/**
 * The probes of a look and a home.
 * @param look - the look.
 * @param plan - the home's workspaces.
 * @returns each probe.
 */
export function probes(look: Look, plan: WorkspacePlan): {
  readonly boot: Probe, readonly sidebar: Probe, readonly noticeShown: Probe, readonly dialogClosed: Probe, readonly settings: Probe
  step(position: number): Probe
  chat(id: string): Probe
} {
  return {
    boot: { afterInput: false, present: [{ selector: ROOT, min: 1 }, { selector: look.sidebarEntry, min: 1 }], absent: [BOOT_SCREEN, `${ROOT}[inert]`] },
    sidebar: { afterInput: false, present: [{ selector: look.sidebarEntry, min: look.sidebarEntries(plan) }], absent: [] },
    noticeShown: { afterInput: false, present: [{ selector: '[role="dialog"][aria-label="Preview"]', min: 1 }], absent: [] },
    dialogClosed: { afterInput: true, present: [{ selector: ROOT, min: 1 }], absent: ['[role="dialog"][aria-modal="true"]', `${ROOT}[inert]`] },
    settings: { afterInput: true, present: [{ selector: '[role="dialog"][data-shortcut-modal="settings"] [data-settings-anchor]', min: 1 }], absent: [] },
    step: position => ({ afterInput: true, present: [{ selector: `[role="dialog"] li[aria-current="step"]:nth-child(${String(position + 1)})`, min: 1 }], absent: [] }),
    chat: id => ({
      afterInput: true,
      present: [{ selector: `[data-conversation-session="${id}"] [data-chat-flow-kind]`, min: 1 }],
      absent: [],
      withoutText: { selector: `[data-conversation-session="${id}"]`, text: 'Loading history…' },
    }),
  }
}

/**
 * Time one item inside the page: wait for its probe while the trigger runs.
 * @param page - the page.
 * @param item - the item, for the failure.
 * @param probe - its completion.
 * @param timeoutMs - the deadline.
 * @param trigger - the input that starts it; none for an item timed from navigation start.
 * @returns the item's time in milliseconds.
 * @throws {Error} from {@link probeFailure} when the page does not show the completion in time.
 */
async function timed(page: Page, item: string, probe: Probe, timeoutMs: number, trigger?: () => Promise<void>): Promise<number> {
  if (trigger !== undefined) await page.evaluate(RESET_INPUT)
  try {
    const [handle] = await Promise.all([page.waitForFunction(probeDone, probe, { polling: 'raf', timeout: timeoutMs }), trigger?.()])
    const done = await handle.jsonValue()
    await handle.dispose()
    if (done === false) throw new Error('the probe answered without completing')
    return done.elapsed
  } catch (error) {
    const counts = await page.evaluate(probeCounts, probe).catch(() => undefined)
    throw probeFailure(item, probe, counts, error)
  }
}

/** A started studio. */
interface Studio {
  readonly browser: Browser
  readonly link: string
  readonly look: Look
  readonly plan: WorkspacePlan
}

/**
 * A page in a fresh browser context: an empty cache and storage, English, a wide window.
 * @param studio - the studio.
 * @param acknowledgeNotice - whether the browser has acknowledged Delorun's preview notice.
 * @param use - drives the page.
 */
async function inFreshPage(studio: Studio, acknowledgeNotice: boolean, use: (page: Page) => Promise<void>): Promise<void> {
  const browserContext = await studio.browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'UTC' })
  try {
    await browserContext.addInitScript({ content: initScript(acknowledgeNotice) })
    await use(await browserContext.newPage())
  } finally {
    await browserContext.close()
  }
}

/**
 * Open the start link and time the page's completions from navigation start.
 * @param page - the page.
 * @param link - the start link.
 * @param waits - the items and their probes.
 * @returns each item's time.
 */
async function load(page: Page, link: string, waits: Readonly<Record<string, Probe>>): Promise<Record<string, number>> {
  await page.goto(link, { waitUntil: 'commit', timeout: LONG_TIMEOUT_MS })
  const entries = await Promise.all(Object.entries(waits).map(async ([item, probe]) => [item, await timed(page, item, probe, LONG_TIMEOUT_MS)] as const))
  return Object.fromEntries(entries)
}

/**
 * Walk the first-run dialog of a fresh browser to its end, timing each step: Delorun's dialog with its step list, or
 * with the stock look the preview notice alone.
 * @param page - the page.
 * @param studio - the studio.
 * @returns the items.
 * @throws {Error} when the last step would open a folder chooser instead of a chat.
 */
async function onboarding(page: Page, studio: Studio): Promise<Record<string, number>> {
  const probe = probes(studio.look, studio.plan)
  const items = await load(page, studio.link, { 'onboarding:shown': probe.noticeShown })
  const dialog = page.locator('[role="dialog"][aria-modal="true"]')
  const steps = dialog.locator('nav li')
  for (const press of onboardingPresses(await steps.count())) {
    if (await dialog.getByRole('button', { name: 'Choose a folder', exact: true }).count() > 0) throw new Error('the first-run dialog\'s last step offers a folder chooser: the home has no default workspace')
    const button = dialog.getByRole('button', { name: press.button, exact: true })
    if (press.reaches === 'closed') {
      items['onboarding:done'] = await timed(page, 'onboarding:done', probe.dialogClosed, ITEM_TIMEOUT_MS, () => button.click())
    } else {
      const item = onboardingStepItem(await steps.nth(press.reaches).locator('span').last().innerText())
      items[item] = await timed(page, item, probe.step(press.reaches), ITEM_TIMEOUT_MS, () => button.click())
    }
  }
  return items
}

/**
 * Open a chat from its sidebar row and time it until its messages render.
 * @param page - the page.
 * @param studio - the studio.
 * @param item - the item.
 * @param chat - the chat and its workspace.
 * @param chat.id - the chat.
 * @param chat.workspace - its workspace.
 * @returns the item's time.
 */
async function openChat(page: Page, studio: Studio, item: string, chat: { readonly id: string, readonly workspace: string }): Promise<number> {
  const row = page.locator(studio.look.chatRow(chat.id))
  const reveal = studio.look.reveal(chat.workspace)
  if (reveal !== undefined && !await row.isVisible()) {
    await page.locator(reveal).click()
    await row.waitFor({ state: 'visible', timeout: ITEM_TIMEOUT_MS })
  }
  return timed(page, item, probes(studio.look, studio.plan).chat(chat.id), chat.id === studio.plan.longChat.id ? LONG_TIMEOUT_MS : ITEM_TIMEOUT_MS, () => row.click())
}

/**
 * Copy a template home, give it its workspaces and look, start it, open a headless Chromium and run the work; the
 * browser closes and the home stops and is removed whether the work succeeds or fails.
 * @param context - the suite context.
 * @param fixtures - the run's fixtures.
 * @param template - the template home.
 * @param look - the look.
 * @param plan - the workspaces.
 * @param onboardingDone - whether the home has finished the first-run dialog.
 * @param work - the measured work.
 */
async function withStudio(
  context: SuiteContext, fixtures: SharedFixtures, template: BenchRoot, look: Look, plan: WorkspacePlan, onboardingDone: boolean,
  work: (studio: Studio) => Promise<void>,
): Promise<void> {
  const root = context.newRoot()
  const home: InstalledHome = { root, launcher: fixtures.channel.launcher }
  let browser: Browser | undefined
  try {
    copyHome(template, root)
    writeWorkspaces(root, plan)
    appendProfileRows(root.delorunHome, `${look.profileRows}${onboardingDone ? ONBOARDING_DONE_ROW : ''}`)
    const { link } = await startForLink(home)
    browser = await chromium.launch({ headless: true, env: childEnvironment(root, []) })
    await work({ browser, link, look, plan })
  } finally {
    await browser?.close()
    await stopHome(home)
    root.dispose()
  }
}

/**
 * One repetition of a look: the small chat set's home for the first-run dialog, boot, chats and Settings, then the
 * large chat set's home, whose first-run dialog is done and whose first page load is not timed, for boot.
 * @param context - the suite context.
 * @param fixtures - the run's fixtures.
 * @param look - the look.
 * @param homes - the templates and plans of the small and the large chat set.
 * @returns the items.
 */
async function repetition(context: SuiteContext, fixtures: SharedFixtures, look: Look, homes: Homes): Promise<Record<string, number>> {
  const items: Record<string, number> = {}
  await withStudio(context, fixtures, homes.few.template, look, homes.few.plan, false, async (studio) => {
    await inFreshPage(studio, false, async (page) => { Object.assign(items, await onboarding(page, studio)) })
    await inFreshPage(studio, true, async (page) => {
      const probe = probes(look, studio.plan)
      Object.assign(items, await load(page, studio.link, { 'boot:few': probe.boot, 'sidebar:few': probe.sidebar }))
      items['chat:short'] = await openChat(page, studio, 'chat:short', studio.plan.shortChat)
      items['chat:long'] = await openChat(page, studio, 'chat:long', studio.plan.longChat)
      items['chat:switch-short'] = await openChat(page, studio, 'chat:switch-short', studio.plan.shortChat)
      items['chat:switch-long'] = await openChat(page, studio, 'chat:switch-long', studio.plan.longChat)
      items.settings = await timed(page, 'settings', probe.settings, ITEM_TIMEOUT_MS, () => page.locator(SETTINGS_BUTTON).locator('visible=true').first().click())
    })
  })
  await withStudio(context, fixtures, homes.many.template, look, homes.many.plan, true, async (studio) => {
    const probe = probes(look, studio.plan)
    await inFreshPage(studio, true, async (page) => { await load(page, studio.link, { warm: probe.boot }) })
    await inFreshPage(studio, true, async (page) => { Object.assign(items, await load(page, studio.link, { 'boot:many': probe.boot, 'sidebar:many': probe.sidebar })) })
  })
  return items
}

/** The two homes a repetition opens. */
interface Homes {
  readonly few: { readonly template: BenchRoot, readonly plan: WorkspacePlan }
  readonly many: { readonly template: BenchRoot, readonly plan: WorkspacePlan }
}

/**
 * A scenario's workload parameters.
 * @param chatsFew - the small chat set's size.
 * @param few - its workspaces.
 * @param chatsMany - the large chat set's size.
 * @param many - its workspaces.
 * @returns the parameters.
 */
export function studioParameters(chatsFew: number, few: WorkspacePlan, chatsMany: number, many: WorkspacePlan): Readonly<Record<string, string | number>> {
  return { chatsFew, workspacesFew: few.workspaces.length, chatsMany, workspacesMany: many.workspaces.length, longChatTurns: few.longChat.turns, browser: 'chromium headless' }
}

/** What the suite does not measure. */
export const STUDIO_SKIPPED: readonly Skipped[] = [
  { item: 'onboarding steps with the stock look', reason: 'the stock look unloads Delorun\'s first-run dialog; only the preview notice of @delorun/bundle-local remains, timed as onboarding:shown and onboarding:done' },
  { item: 'onboarding:plugins and onboarding:reach', reason: 'a fresh home leaves both steps out: the recommended plugin list is empty by default and no plugin provides reach on this base' },
  { item: 'chats and Settings with the large chat set', reason: 'they are timed in the small set\'s home; the large set changes the sidebar, which boot:many and sidebar:many time' },
  { item: 'the desktop application', reason: 'the suite drives the Web studio in headless Chromium; the desktop shell is not started' },
]

/** The suite. */
export const studioSuite: Suite = {
  id: 'studio',
  title: 'The studio page in a browser, Delorun\'s composition against the stock look',
  items: STUDIO_ITEMS,
  scenarios: LOOKS.map(({ id, description }) => ({ id, description })),
  async run(context: SuiteContext, selected: readonly string[]): Promise<SuiteResult> {
    const fixtures = await context.fixtures()
    const { chatsSmall, chatsLarge, repeat } = context.options
    const corpus = await corpusModules()
    const homes: Homes = {
      few: { template: await templateHome(context, `chats-${String(chatsSmall)}-plugins-none`, chatsSmall), plan: workspacePlan(chatsSmall, corpus) },
      many: { template: await templateHome(context, `chats-${String(chatsLarge)}-plugins-none`, chatsLarge), plan: workspacePlan(chatsLarge, corpus) },
    }
    fixtures.channel.serve(await installedChannel(fixtures))
    const results: ScenarioResult[] = []
    for (const look of LOOKS.filter(candidate => selected.includes(candidate.id))) {
      const samples = new Samples()
      const failures: string[] = []
      let completed = 0
      for (let index = 0; index < repeat; index++) {
        context.log(`studio/${look.id}: repetition ${String(index + 1)} of ${String(repeat)}`)
        try {
          samples.addAll(await repetition(context, fixtures, look, homes))
          completed++
        } catch (error) {
          failures.push(context.scrubber.scrub(error instanceof Error ? error.message : String(error)))
        }
      }
      results.push({
        scenario: look.id, description: look.description, completed, phases: samples.results(Object.keys(STUDIO_ITEMS)), failures,
        parameters: studioParameters(chatsSmall, homes.few.plan, chatsLarge, homes.many.plan),
      })
    }
    return { suite: 'studio', scenarios: results, skipped: [...STUDIO_SKIPPED] }
  },
}
