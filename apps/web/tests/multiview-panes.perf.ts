// Opt-in browser benchmark for Multiview in a Delorun profile: a main chat with a 500-turn history and five agent chats,
// all pinned, drawn as six panes. It reports measurements without timing assertions because host speed is not a
// correctness contract; structural assertions keep the six panes and the windowed transcripts from silently changing.
// Same measurement helpers as complex-history.perf.ts, run with `--config vitest.web.perf.config.ts`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { Browser, CDPSession, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
// Carry the session/title and subagent event declarations into the fixture builders.
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-subagent'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { acknowledgeDelorunNotice, newEnglishPage } from './support.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BUNDLE_LOCAL = join(REPO, 'delorun/packages/bundle-local')
const MAIN_ID = SessionId('mv-perf-main')
const MAIN_TURNS = 500
const AGENT_COUNT = 5
const AGENT_TURNS = 100
/** The most turns a transcript window mounts at once; the product's default window is 24. */
const MOUNTED_TURN_LIMIT = 30
const TOOL_TURN_INTERVAL = 10
const TOOLS_PER_TOOL_TURN = 10
const STREAM_PACE_MS = 8
const STREAM_DELTA_COUNT = 120
const PERF_REPLAY_CONTEXT_WINDOW = 10_000_000
const AGENT_IDS = Array.from({ length: AGENT_COUNT }, (_, index) => SessionId(`mv-perf-agent-${String(index + 1)}`))
const AGENT_LABELS = ['Run the tests', 'Review the diff', 'Check the docs', 'Audit dependencies', 'Profile the build']
const TURN_TAIL = '[data-chat-flow-key^="9:turn-tail"]'

interface ChromiumMetrics {
  readonly [name: string]: number
}

interface Measurement {
  readonly wallMs: number
  readonly taskMs: number
  readonly scriptMs: number
  readonly layoutMs: number
  readonly recalcStyleMs: number
  readonly nodesDelta: number
  readonly listenersDelta: number
  readonly heapDeltaMb: number
  readonly totalNodes: number
  readonly heapMb: number
}

interface RetainedState {
  readonly domElements: number
  readonly nodes: number
  readonly listeners: number
  readonly heapMb: number
}

const text = (value: string): { type: 'text'; text: string }[] => [{ type: 'text', text: value }]

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function requiredMetric(metrics: ChromiumMetrics, name: string): number {
  const value = metrics[name]
  if (value === undefined) throw new Error(`Chromium performance metric ${name} is unavailable`)
  return value
}

async function chromiumMetrics(cdp: CDPSession): Promise<ChromiumMetrics> {
  const payload = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(payload.metrics.map(metric => [metric.name, metric.value]))
}

function metricDelta(before: ChromiumMetrics, after: ChromiumMetrics, wallMs: number): Measurement {
  const ms = (name: string): number => rounded((requiredMetric(after, name) - requiredMetric(before, name)) * 1_000)
  return {
    wallMs: rounded(wallMs),
    taskMs: ms('TaskDuration'),
    scriptMs: ms('ScriptDuration'),
    layoutMs: ms('LayoutDuration'),
    recalcStyleMs: ms('RecalcStyleDuration'),
    nodesDelta: requiredMetric(after, 'Nodes') - requiredMetric(before, 'Nodes'),
    listenersDelta: requiredMetric(after, 'JSEventListeners') - requiredMetric(before, 'JSEventListeners'),
    heapDeltaMb: rounded((requiredMetric(after, 'JSHeapUsedSize') - requiredMetric(before, 'JSHeapUsedSize')) / 1_048_576),
    totalNodes: requiredMetric(after, 'Nodes'),
    heapMb: rounded(requiredMetric(after, 'JSHeapUsedSize') / 1_048_576),
  }
}

/** Print the functions with the most self time of a CPU profile, grouped by name and script. */
interface CpuProfile {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>
  samples?: number[]
  timeDeltas?: number[]
}

function printProfile(profile: CpuProfile): void {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const self = new Map<string, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  samples.forEach((id, index) => {
    const frame = byId.get(id)?.callFrame
    if (frame === undefined) return
    const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').slice(-2).join('/')}:${String(frame.lineNumber)}`
    self.set(key, (self.get(key) ?? 0) + (deltas[index] ?? 0) / 1000)
  })
  const top = [...self.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30)
  console.log(`CPU PROFILE (self ms)\n${top.map(([key, ms]) => `${ms.toFixed(0).padStart(6)}  ${key}`).join('\n')}`)
}

async function measure<T>(cdp: CDPSession, action: () => Promise<T>): Promise<{ measurement: Measurement; value: T }> {
  const before = await chromiumMetrics(cdp)
  const started = performance.now()
  const value = await action()
  const wallMs = performance.now() - started
  const after = await chromiumMetrics(cdp)
  return { measurement: metricDelta(before, after, wallMs), value }
}

async function retainedState(cdp: CDPSession, page: Page): Promise<RetainedState> {
  await cdp.send('HeapProfiler.collectGarbage')
  const metrics = await chromiumMetrics(cdp)
  return {
    domElements: await page.evaluate(() => document.querySelectorAll('*').length),
    nodes: requiredMetric(metrics, 'Nodes'),
    listeners: requiredMetric(metrics, 'JSEventListeners'),
    heapMb: rounded(requiredMetric(metrics, 'JSHeapUsedSize') / 1_048_576),
  }
}

function appendSystemPrompt(session: Session, turn: number, step: number): void {
  session.append('system/message', { turn, step, message: createSystemMessage('Synthetic performance system prompt.') }, { surfaceOp: 'append' })
}

function appendAssistant(session: Session, turn: number, step: number, body: string): void {
  session.append('assistant/message', {
    stream: [], turn, step,
    message: createAssistantMessage({ content: text(body), source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
    usage: { inputTokens: 4_000 + turn * 10, outputTokens: 200 + step * 20 },
  }, { surfaceOp: 'append' })
}

function appendToolStep(session: Session, turn: number, step: number, toolCount: number): void {
  const calls = Array.from({ length: toolCount }, (_, index) => ({
    callId: ToolCallId(`mv-perf-call-${String(turn)}-${String(index)}`),
    index,
    args: JSON.stringify({ turn, index, payload: 'x'.repeat(120) }),
  }))
  session.append('assistant/message', {
    stream: [], turn, step,
    message: createAssistantMessage({
      content: [
        { type: 'reasoning', text: `Dispatching ${String(toolCount)} synthetic tools for turn ${String(turn)}.` },
        ...calls.map(({ callId, args }) => ({ type: 'tool-call' as const, id: callId, name: 'synthetic_tool', arguments: args })),
      ],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: { inputTokens: 6_000 + turn * 10, outputTokens: 500, reasoningTokens: 50 },
  }, { surfaceOp: 'append' })
  const callEvents = calls.map(({ callId, args }) => session.append('tool/call', { turn, step, callId, name: 'synthetic_tool', arguments: args }))
  for (const [index, call] of calls.entries()) {
    const source = callEvents[index]
    if (source === undefined) throw new Error(`missing synthetic tool call ${String(index)}`)
    session.append('tool/result', {
      turn, step,
      message: createToolResultMessage({ callId: call.callId, content: text(`synthetic result turn=${String(turn)} index=${String(call.index)} ${'r'.repeat(400)}`), isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
}

function fencedCode(turn: number): string {
  if (turn % 25 !== 0) return ''
  const lines = Array.from({ length: 80 }, (_, index) => `const value_${String(index)} = ${String(turn + index)}`)
  return `\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\``
}

/**
 * Append `turns` finished turns, a tool turn every {@link TOOL_TURN_INTERVAL}th, to a detached Session.
 * @param session - the Session being built.
 * @param turns - how many turns to append.
 * @param label - the text each turn's messages start with.
 * @param titled - whether the first turn also records the chat's title.
 */
function appendHistory(session: Session, turns: number, label: string, titled: boolean): void {
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) appendSystemPrompt(session, turn, 1)
    const user = session.append('user/message', createUserMessage({
      content: text(`${label} turn ${String(turn)}: analyze payload ${'u'.repeat(200)}`), source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1 && titled) session.append('session/title', { title: `${label} history`, messageSeqs: [user.seq], source: { kind: 'fallback' } })
    if (turn % TOOL_TURN_INTERVAL === 0) {
      appendToolStep(session, turn, 1, TOOLS_PER_TOOL_TURN)
      session.append('step/end', { turn, step: 1 })
      session.append('step/start', { turn, step: 2 })
      appendAssistant(session, turn, 2, `All synthetic tools completed for turn ${String(turn)}. ${'z'.repeat(320)}${fencedCode(turn)}`)
      session.append('step/end', { turn, step: 2 })
    } else {
      appendAssistant(session, turn, 1, `Synthetic ${label} response for turn ${String(turn)}. ${'a'.repeat(320)}${fencedCode(turn)}`)
      session.append('step/end', { turn, step: 1 })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

async function persist(scaffold: WebScaffold, meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const seeder = new Context()
  try {
    await seeder.plugin(JsonlSessionPersistence, { root: scaffold.persistenceRoot })
    const handle = await seeder.sessionPersistence.create(meta)
    await handle.append(events)
    await handle.close()
  } finally {
    await seeder.fiber.dispose()
  }
}

/**
 * Write the main chat, which lists {@link AGENT_COUNT} agents, and the agents' own chats into the scaffold's store.
 * @param scaffold - the booted scaffold.
 */
async function seedChats(scaffold: WebScaffold): Promise<void> {
  const now = Date.now()
  const header = (id: SessionId, extra: Partial<SessionHeader>): SessionHeader => ({
    version: SESSION_FORMAT_VERSION, id, createdAt: now - 3_600_000, cwd: scaffold.workspaceCwd, isSeeded: false,
    delegationDepth: 0, ...extra,
  })
  const main = Session.create(MAIN_ID)
  appendHistory(main, MAIN_TURNS, 'MV_PERF_MAIN', true)
  AGENT_IDS.forEach((id, index) => {
    main.append('subagent/catalog', {
      version: 3, childId: id, childCreatedAt: now - 3_000_000 + index, mode: 'continuable', label: AGENT_LABELS[index]!, name: `agent-${String(index + 1)}`,
    })
  })
  await persist(scaffold, header(MAIN_ID, {}), main.snapshotEvents())
  for (const [index, id] of AGENT_IDS.entries()) {
    const child = Session.create(id)
    child.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'subagent', label: AGENT_LABELS[index]! })
    appendHistory(child, AGENT_TURNS, `MV_PERF_AGENT_${String(index + 1)}`, false)
    await persist(scaffold, header(id, { parentSession: MAIN_ID, origin: 'subagent', delegationDepth: 1, createdAt: now - 3_000_000 }), child.snapshotEvents())
  }
}

function textStream(deltas: readonly string[]): StreamChunk[] {
  const response = deltas.join('')
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map(delta => ({ type: 'text-delta' as const, index: 0, text: delta })),
    { type: 'block-end', index: 0, block: { type: 'text', text: response } },
    { type: 'usage', usage: { inputTokens: 1_000, outputTokens: Math.ceil(response.length / 4) } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** The streamed reply's deltas, with markers on the first and last. */
function streamDeltas(tag: string): string[] {
  return Array.from({ length: STREAM_DELTA_COUNT }, (_, index) => {
    if (index === 0) return `${tag}_FIRST `
    if (index === STREAM_DELTA_COUNT - 1) return `${tag}_DONE.`
    return `chunk-${String(index).padStart(3, '0')} ${'response'.repeat(3)} `
  })
}

function replayOverride(tags: readonly string[]): ReplayOverrideDoc {
  return tags.map((tag): ReplayEntry => ({ kind: 'chunks', chunks: textStream(streamDeltas(tag)) }))
}

/**
 * Send one prompt from the main pane's composer and wait for the whole streamed reply.
 * @param scaffold - the booted scaffold, whose turn end settles the measurement.
 * @param page - the page under test.
 * @param tag - the marker the replayed reply starts and ends with.
 * @returns the click-to-first-chunk and click-to-done times in milliseconds.
 */
async function streamOnce(scaffold: WebScaffold, page: Page, tag: string): Promise<{ firstChunkMs: number; settledMs: number }> {
  const main = page.locator(`[data-pane="${MAIN_ID}"]`)
  const scope = (await main.count()) > 0 ? main : page.locator('body')
  const composer = scope.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 15_000 })
  const prompt = `${tag}_PROMPT stream one reply`
  await composer.fill(prompt)
  await expect.poll(() => composer.textContent()).toBe(prompt)
  const settled = scaffold.whenTurnSettled(60_000)
  const send = scope.getByRole('button', { name: 'Send message', exact: true }).last()
  await expect.poll(() => send.isEnabled(), { timeout: 15_000 }).toBe(true)
  const started = performance.now()
  await send.click()
  await page.getByText(`${tag}_FIRST`, { exact: false }).last().waitFor({ timeout: 30_000 })
  const firstChunkMs = performance.now() - started
  await settled
  await page.getByText(`${tag}_DONE`, { exact: false }).last().waitFor({ timeout: 30_000 })
  await expect.poll(() => page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)
  return { firstChunkMs: rounded(firstChunkMs), settledMs: rounded(performance.now() - started) }
}

/** Open a seeded chat from the sidebar; the Ungrouped folder starts collapsed. */
async function openChat(page: Page, id: SessionId): Promise<void> {
  const row = page.locator(`[data-row-key="session:${id}"]`)
  const folder = page.locator('[data-row-key="workspace:"]')
  await folder.waitFor({ timeout: 30_000 })
  await expect.poll(async () => {
    if (await row.isVisible()) return true
    if (await folder.getAttribute('aria-expanded') === 'false') await folder.click({ timeout: 2_000 }).catch(() => undefined)
    return false
  }, { timeout: 30_000 }).toBe(true)
  await row.click({ timeout: 15_000 })
  await expect.poll(() => row.getAttribute('aria-selected'), { timeout: 15_000 }).toBe('true')
}

/** Loaded-window turn count of one scope: one mounted turn-tail footer per settled turn in the window. */
async function mountedTurns(page: Page, scope: string): Promise<number> {
  let previous = -1
  let stable = 0
  const deadline = performance.now() + 60_000
  while (performance.now() < deadline) {
    const count = await page.locator(`${scope} ${TURN_TAIL}`).count()
    stable = count > 0 && count === previous ? stable + 1 : 0
    if (stable >= 4) return count
    previous = count
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`mounted turn count of ${scope} did not stabilize; last ${String(previous)}`)
}

/**
 * Print what a trace says about style recalculation: how many passes, how long, how wide, and what
 * invalidated the widest ones.
 * @param label - the stream the trace covers.
 * @param traced - the collected trace events.
 */
function reportTrace(label: string, traced: readonly { name: string; ts?: number; dur?: number; args?: Record<string, unknown> }[]): void {
  const widthOf = (event: { args?: Record<string, unknown> }): number =>
    Number((event.args as { elementCount?: number } | undefined)?.elementCount ?? 0)
  const recalcs = traced.filter(event => event.name === 'UpdateLayoutTree' && event.dur !== undefined)
  const totalMs = recalcs.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000
  const widths = recalcs.map(widthOf).sort((left, right) => left - right)
  const wide = recalcs.filter(event => widthOf(event) > 2000)
  const wideMs = wide.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000
  console.log(`RECALC ${label}: passes=${String(recalcs.length)} totalMs=${totalMs.toFixed(0)} medianElements=${String(widths[Math.floor(widths.length / 2)] ?? 0)} maxElements=${String(widths.at(-1) ?? 0)} widePasses=${String(wide.length)} wideMs=${wideMs.toFixed(0)}`)
  const invalidations = traced.filter(event => event.name === 'StyleRecalcInvalidationTracking')
  const keyOf = (event: { args?: Record<string, unknown> }): string => {
    const data = (event.args as { data?: Record<string, unknown> }).data ?? {}
    return `${String(data.reason)} <${String(data.nodeName ?? '')}> ${String(data.extraData ?? '')}`
  }
  const reasons = new Map<string, number>()
  for (const event of invalidations) reasons.set(keyOf(event), (reasons.get(keyOf(event)) ?? 0) + 1)
  console.log(`INVALIDATION REASONS ${label}\n${[...reasons.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([key, count]) => `${String(count).padStart(6)} ${key}`).join('\n')}`)
  for (const pass of wide.slice(0, 3)) {
    const from = (pass.ts ?? 0) - 30_000
    const near = invalidations.filter(event => (event.ts ?? 0) >= from && (event.ts ?? 0) <= (pass.ts ?? 0))
    const nearReasons = new Map<string, number>()
    for (const event of near) nearReasons.set(keyOf(event), (nearReasons.get(keyOf(event)) ?? 0) + 1)
    console.log(`WIDE PASS ${String((pass.dur ?? 0) / 1000)}ms elements=${String(widthOf(pass))} preceded by\n${[...nearReasons.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([key, count]) => `${String(count).padStart(6)} ${key}`).join('\n')}`)
  }
}

describe('manual web performance: Multiview panes', () => {
  let browser: Browser

  beforeAll(async () => {
    if (webSnapshotMode() === 'record') throw new Error('manual web performance runs only with deterministic replay')
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('reports the cost of six panes: a 500-turn main chat and five pinned agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delorun-multiview-perf-'))
    const originalHome = process.env.DELORUN_HOME
    process.env.DELORUN_HOME = join(root, 'delorun-home')
    await mkdir(process.env.DELORUN_HOME, { recursive: true })
    const overlay = join(root, 'multiview-perf.yml')
    await writeFile(overlay, JSON.stringify([{ id: 'delorun-update-gate', config: { holdUntilChecked: false } }]))
    const replayOverrideFile = join(root, 'replay.override.json')
    await writeFile(replayOverrideFile, JSON.stringify(replayOverride(['MV_STREAM_CLOSED', 'MV_STREAM_OPEN'])))
    const scaffold = await launchWebScaffold({
      extraOverlayPath: overlay,
      profile: { packages: [{ dir: BUNDLE_LOCAL, enabled: true }] },
      // The override-only fixture supplies the two scripts for this world's one live chat.
      replayFixture: join(root, 'override-only.jsonl'),
      replayOverride: replayOverrideFile,
      paceMs: STREAM_PACE_MS,
      replayContextWindow: PERF_REPLAY_CONTEXT_WINDOW,
    })
    const page = await newEnglishPage(browser)
    try {
      const setupStarted = performance.now()
      await seedChats(scaffold)
      const seedMs = rounded(performance.now() - setupStarted)
      const tripwire = watchConsole(page)
      await page.setViewportSize({ width: 1920, height: 1080 })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await acknowledgeDelorunNotice(page)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Performance.enable')

      const opened = await measure(cdp, async () => {
        await openChat(page, MAIN_ID)
        return mountedTurns(page, 'body')
      })
      expect(opened.value).toBeLessThanOrEqual(MOUNTED_TURN_LIMIT)
      const closedState = await retainedState(cdp, page)
      const profileClosed = process.env.MV_PROFILE === 'closed'
      if (profileClosed) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start') }
      const closedTraced: Array<{ name: string; ts?: number; dur?: number; args?: Record<string, unknown> }> = []
      const closedTracing = process.env.MV_PROFILE === 'trace'
      if (closedTracing) {
        cdp.on('Tracing.dataCollected', (payload) => { closedTraced.push(...(payload.value as typeof closedTraced)) })
        await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking'] } } as never)
      }
      const closedStream = await measure(cdp, () => streamOnce(scaffold, page, 'MV_STREAM_CLOSED'))
      if (closedTracing) {
        const closedDone = new Promise<void>((resolve) => { cdp.once('Tracing.tracingComplete', () => { resolve() }) })
        await cdp.send('Tracing.end')
        await closedDone
        reportTrace('closed', closedTraced)
      }
      if (profileClosed) printProfile((await cdp.send('Profiler.stop')).profile)

      await page.getByRole('button', { name: `${String(AGENT_COUNT)} subagents` }).click()
      for (const label of AGENT_LABELS) await page.getByRole('button', { name: `Pin ${label} to Multiview` }).click()
      await page.keyboard.press('Escape')
      // The toggle's accessible name is "Multiview"; the pinned count is its description, so wait on that.
      await expect.poll(() => page.getByRole('button', { name: /^Multiview(,|$)/ }).getAttribute('aria-description'), { timeout: 15_000 })
        .toBe(`${String(AGENT_COUNT)} pinned`)

      const region = page.getByRole('region', { name: 'Multiview' })
      const paneIds = [MAIN_ID, ...AGENT_IDS]
      const openMultiview = await measure(cdp, async () => {
        await page.getByRole('button', { name: /^Multiview(,|$)/ }).click()
        await region.waitFor({ timeout: 30_000 })
        await expect.poll(() => region.locator('[data-pane-header]').count(), { timeout: 30_000 }).toBe(paneIds.length)
        // A pane is drawn once its chat's newest turns are mounted.
        await expect.poll(async () => {
          const counts = await Promise.all(paneIds.map(id => page.locator(`[data-pane="${id}"] ${TURN_TAIL}`).count()))
          return counts.every(count => count > 0)
        }, { timeout: 60_000 }).toBe(true)
      })
      const mounted: Record<string, number> = {}
      for (const id of paneIds) mounted[id] = await mountedTurns(page, `[data-pane="${id}"]`)
      const openState = await retainedState(cdp, page)
      // MV_PROFILE=1 samples the CPU during the six-pane stream and prints the functions with the most self time; MV_PROFILE=closed does
      // the same for the closed stream, and MV_PROFILE=trace prints the largest style recalculations and what invalidated them.
      const profiling = process.env.MV_PROFILE === '1'
      const tracing = process.env.MV_PROFILE === 'trace'
      const traced: Array<{ name: string; ts?: number; dur?: number; args?: Record<string, unknown> }> = []
      if (tracing) {
        cdp.on('Tracing.dataCollected', (payload) => { traced.push(...(payload.value as typeof traced)) })
        await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking'] } } as never)
      }
      if (profiling) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start') }
      const openStream = await measure(cdp, () => streamOnce(scaffold, page, 'MV_STREAM_OPEN'))
      if (profiling) printProfile((await cdp.send('Profiler.stop')).profile)
      if (tracing) {
        const done = new Promise<void>((resolve) => { cdp.once('Tracing.tracingComplete', () => { resolve() }) })
        await cdp.send('Tracing.end')
        await done
        reportTrace('six panes', traced)
      }

      // Structure: six panes, and each pane mounts only the newest part of its chat.
      expect(await region.locator('[data-pane-header]').count()).toBe(paneIds.length)
      expect(mounted[MAIN_ID]).toBeLessThanOrEqual(MOUNTED_TURN_LIMIT)
      expect(mounted[MAIN_ID]).toBeLessThan(MAIN_TURNS / 10)
      for (const id of AGENT_IDS) {
        expect(mounted[id], id).toBeLessThanOrEqual(MOUNTED_TURN_LIMIT)
        expect(mounted[id], id).toBeLessThan(AGENT_TURNS / 2)
      }

      await page.getByRole('button', { name: /^Multiview(,|$)/ }).click()
      await region.waitFor({ state: 'detached', timeout: 15_000 })
      const reclosedState = await retainedState(cdp, page)

      const row = (name: string, value: string | number): string => `${name.padEnd(46)}${String(value).padStart(10)}`
      const table = [
        'MULTIVIEW PANES (1920x1080; main chat 500 turns, 5 agents 100 turns each; no timing assertions)',
        row('seed the six chats (ms)', seedMs),
        row('open main chat, Multiview closed (ms)', opened.measurement.wallMs),
        row('Multiview closed: DOM elements', closedState.domElements),
        row('Multiview closed: Chromium nodes', closedState.nodes),
        row('Multiview closed: JS listeners', closedState.listeners),
        row('Multiview closed: heap after GC (MB)', closedState.heapMb),
        row('press Multiview -> six panes drawn (ms)', openMultiview.measurement.wallMs),
        row('  of which script (ms)', openMultiview.measurement.scriptMs),
        row('  of which layout (ms)', openMultiview.measurement.layoutMs),
        row('  of which style recalculation (ms)', openMultiview.measurement.recalcStyleMs),
        row('  nodes added', openMultiview.measurement.nodesDelta),
        row('Multiview open: DOM elements', openState.domElements),
        row('Multiview open: Chromium nodes', openState.nodes),
        row('Multiview open: JS listeners', openState.listeners),
        row('Multiview open: heap after GC (MB)', openState.heapMb),
        row('Multiview closed again: DOM elements', reclosedState.domElements),
        row('mounted turns, main pane (of 500)', mounted[MAIN_ID]!),
        row('mounted turns, agent panes (of 100 each)', AGENT_IDS.map(id => mounted[id]).join(',')),
        row('stream 120 chunks, closed: wall (ms)', closedStream.measurement.wallMs),
        row('stream 120 chunks, closed: script (ms)', closedStream.measurement.scriptMs),
        row('stream 120 chunks, closed: style recalc (ms)', closedStream.measurement.recalcStyleMs),
        row('stream 120 chunks, closed: first chunk (ms)', closedStream.value.firstChunkMs),
        row('stream 120 chunks, six panes: wall (ms)', openStream.measurement.wallMs),
        row('stream 120 chunks, six panes: script (ms)', openStream.measurement.scriptMs),
        row('stream 120 chunks, closed: layout (ms)', closedStream.measurement.layoutMs),
        row('stream 120 chunks, six panes: layout (ms)', openStream.measurement.layoutMs),
        row('stream 120 chunks, six panes: style recalc (ms)', openStream.measurement.recalcStyleMs),
        row('stream 120 chunks, six panes: first chunk (ms)', openStream.value.firstChunkMs),
      ].join('\n')
      console.info(`WEB_PERF_RESULT multiview-panes\n${table}`)
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.close().catch(() => undefined)
      await scaffold.close().catch(() => undefined)
      if (originalHome === undefined) Reflect.deleteProperty(process.env, 'DELORUN_HOME')
      else process.env.DELORUN_HOME = originalHome
      await rm(root, { recursive: true, force: true })
    }
  })
})
