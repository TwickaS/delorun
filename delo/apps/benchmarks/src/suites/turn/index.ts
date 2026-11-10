/**
 * The turn suite: what Delo adds to a chat turn around the model, and to each tool call in it. Each repetition copies
 * an installed home, starts it with `delorun start` against the loopback model stub ({@link ./model-stub.ts}), signs in
 * to the studio with the start link and drives one new chat through the studio's Web API ({@link ./studio-client.ts}),
 * the path the studio's page takes. The chat's folder is a project folder outside the Delo home. In order, it sends:
 *
 * - the chat's first message, answered with text (cold: the first turn of the Host, with the chat's title request);
 * - a second message, answered with text;
 * - a message answered after {@link TOOL_CALLS} `read` calls of a small file in the folder;
 * - a message answered after {@link TOOL_CALLS} `write` calls, each creating a new file in the folder.
 *
 * The client's times come from the follow frames, the model's from the stub, both read by this process's clock. The
 * time of a tool call is the Host's time between the stub ending the reply that calls the tool and the next model
 * request arriving: parsing the call, every check and guard, running the tool, recording the result and assembling the
 * next request. No call asks the person: `read` never asks, and `write` inside the chat's folder runs under the
 * folder's `workspace-write` preset without asking, in both compositions; a call that fails or is refused fails the
 * repetition, so a refusal is never measured as a fast call.
 *
 * Scenarios: `delorun` runs the home as setup leaves it; `stock` adds to the profile's patch the rows of the C16 parity
 * form for the six switch rows `@delo/bundle-local` inserts (consents, fetch guard and update gate), restated disabled,
 * read from the installed runtime's bundle, so the same home runs those rows as upstream's composition does. The
 * sandbox row's home protection stays in both: `delorun start` writes it on every start.
 *
 * @module @delo/benchmarks/suites/turn
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyHome, killLeftovers, PROFILE, runtimeDirectory, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { INSTALLED_VERSION, installedChannel, templateHome } from '../../fixtures/releases.ts'
import { Samples, type ScenarioResult, type SuiteResult } from '../../harness/result.ts'
import type { BenchRoot } from '../../harness/roots.ts'
import type { Suite, SuiteContext } from '../../harness/suite.ts'
import { startForLink } from '../start/index.ts'
import { startModelStub, turnScript, type ModelStub, type ScriptedTool, type StubExchange } from './model-stub.ts'
import { openStudio, sessionIdOf, type TurnTimes } from './studio-client.ts'

/** Tool calls in each tool turn: enough that the first call's one-time work is one sample among many. */
export const TOOL_CALLS = 20

/** The answer's text, one delta per chunk. */
export const ANSWER: readonly string[] = ['The ', 'benchmark ', 'turn ', 'is ', 'done.']

/** The chat's folder, under the root's home and outside the Delo home. */
export const PROJECT_DIRECTORY = 'project'

/** The file the `read` calls read. */
export const READ_FILE = 'notes.txt'

/** The tools the tool turns call. */
export const TOOLS: Readonly<Record<'read' | 'write', ScriptedTool>> = {
  read: { name: 'read', input: () => JSON.stringify({ file_path: READ_FILE }) },
  write: { name: 'write', input: call => JSON.stringify({ file_path: `written-${String(call).padStart(2, '0')}.txt`, content: `Benchmark file ${String(call)}.\n` }) },
}

/** The longest one turn may take. */
const TURN_TIMEOUT_MS = 120_000

/** The suite's items. */
export const TURN_ITEMS: Readonly<Record<string, string>> = {
  'first-token-cold': 'A new chat\'s first message after Delo started, from sending it to the first text of the answer reaching the studio client',
  'turn-end-cold': 'The first message, from sending it to the turn\'s end reaching the client',
  'first-token': 'A later message answered with text, from sending it to the first text reaching the client',
  'turn-end': 'A later message, from sending it to the turn\'s end reaching the client',
  'to-model': 'A later message, from sending it to the model request arriving at the stub: admission, context and request assembly',
  'token-delivery': 'A later message, from the stub writing the first text to that text reaching the client',
  'model-to-end': 'A later message, from the stub ending the answer to the turn\'s end reaching the client',
  'read-first': 'The first `read` call of a turn, from the stub ending the reply that calls it to the next model request arriving',
  'read': 'Each later `read` call of the turn, the same span',
  'read-turn': `A message answered after ${String(TOOL_CALLS)} \`read\` calls, from sending it to the turn's end reaching the client`,
  'write-first': 'The first `write` call of a turn, from the stub ending the reply that calls it to the next model request arriving',
  'write': 'Each later `write` call of the turn, the same span',
  'write-turn': `A message answered after ${String(TOOL_CALLS)} \`write\` calls, from sending it to the turn's end reaching the client`,
}

/** The suite's scenarios. */
export const TURN_SCENARIOS: readonly { readonly id: 'delorun' | 'stock', readonly description: string }[] = [
  { id: 'delorun', description: 'Delo\'s composition, as setup leaves the home' },
  { id: 'stock', description: 'The same home with the six switch rows of @delo/bundle-local (consents, fetch guard, update gate) disabled, their C16 parity form' },
]

/**
 * The switch rows a bundle patch inserts: each inserted row whose `config` turns `enabled` on.
 * @param patch - the text of `@delo/bundle-local`'s `cordis.patch.yml`.
 * @returns the rows' ids, in patch order.
 */
export function switchRows(patch: string): readonly string[] {
  const rows: string[] = []
  let current: string | undefined
  let inConfig = false
  for (const line of patch.split('\n')) {
    const row = /^ {4}- id: (\S+)$/u.exec(line)
    if (row !== null) {
      current = row[1]
      inConfig = false
    } else if (/^\S/u.test(line)) current = undefined
    else if (current !== undefined && line === '      config:') inConfig = true
    else if (current !== undefined && inConfig && line === '        enabled: true' && rows.at(-1) !== current) rows.push(current)
  }
  return rows
}

/**
 * The profile patch rows of the `stock` scenario.
 * @param rows - the switch rows.
 * @returns each row restated disabled, as patch text.
 * @throws {Error} when there is no row, so a changed bundle cannot turn the scenario into a second `delorun`.
 */
export function stockPatch(rows: readonly string[]): string {
  if (rows.length === 0) throw new Error('@delo/bundle-local inserts no switch row; the stock scenario would equal delorun')
  return rows.map(id => `- id: ${id}\n  disabled: true\n`).join('')
}

/** One finished turn: when its prompt left, what the client saw and what the stub saw from then. */
export interface FinishedTurn {
  readonly sentAt: number
  readonly times: TurnTimes
  /** The stub's turn requests since the prompt left, in arrival order. */
  readonly requests: readonly StubExchange[]
}

/**
 * The milliseconds between two times when both are known and in order.
 * @param from - the earlier time.
 * @param to - the later time.
 * @returns the difference, or `undefined`.
 */
function span(from: number | undefined, to: number | undefined): number | undefined {
  return from === undefined || to === undefined || to < from ? undefined : to - from
}

/**
 * Throw unless a turn ran as scripted: it completed, the stub answered one request per reply, each tool call came
 * back to the model as a result that is not an error, and the client saw each call and its result.
 * @param turn - the turn.
 * @param toolCalls - the tool calls scripted.
 * @param label - the turn's name, for the message.
 * @throws {Error} naming what differed.
 */
export function checkTurn(turn: FinishedTurn, toolCalls: number, label: string): void {
  const problems: string[] = []
  if (turn.times.endReason !== 'completed') problems.push(`it ended ${String(turn.times.endReason)}`)
  if (turn.requests.length !== toolCalls + 1) problems.push(`the model got ${String(turn.requests.length)} requests for ${String(toolCalls + 1)} replies`)
  turn.requests.slice(1).forEach((request, index) => {
    const previous = turn.requests[index]!.reply
    const result = request.toolResults.find(candidate => previous?.kind === 'tool' && candidate.id === previous.id)
    if (result === undefined) problems.push(`request ${String(index + 2)} carried no result for the call before it`)
    else if (result.isError) problems.push(`tool call ${String(index + 1)} failed or was refused`)
  })
  if (turn.times.tools.length !== toolCalls || turn.times.tools.some(tool => tool.result === undefined || tool.isError)) problems.push(`the client saw ${String(turn.times.tools.length)} tool calls with ${String(turn.times.tools.filter(tool => tool.result !== undefined && !tool.isError).length)} good results`)
  if (turn.times.firstText === undefined) problems.push('the client saw no text')
  if (problems.length > 0) throw new Error(`the ${label} turn did not run as scripted: ${problems.join('; ')}`)
}

/**
 * The items of a turn answered with text.
 * @param turn - the turn.
 * @param cold - whether it is the chat's first turn after start.
 * @returns the items that could be measured.
 */
export function textItems(turn: FinishedTurn, cold: boolean): Record<string, number> {
  const request = turn.requests[0]
  const items: Record<string, number | undefined> = cold
    ? { 'first-token-cold': span(turn.sentAt, turn.times.firstText), 'turn-end-cold': span(turn.sentAt, turn.times.end) }
    : {
        'first-token': span(turn.sentAt, turn.times.firstText),
        'turn-end': span(turn.sentAt, turn.times.end),
        'to-model': span(turn.sentAt, request?.arrivedAt),
        'token-delivery': span(request?.firstTextAt, turn.times.firstText),
        'model-to-end': span(request?.endedAt, turn.times.end),
      }
  return Object.fromEntries(Object.entries(items).filter((entry): entry is [string, number] => entry[1] !== undefined))
}

/**
 * The samples of a tool turn: its first call, each later call, and the whole turn.
 * @param turn - the turn.
 * @param tool - the tool's item prefix.
 * @returns each item's samples.
 */
export function toolItems(turn: FinishedTurn, tool: string): Record<string, number[]> {
  const calls = turn.requests.slice(1).flatMap((request, index) => {
    const call = span(turn.requests[index]!.endedAt, request.arrivedAt)
    return call === undefined ? [] : [call]
  })
  const whole = span(turn.sentAt, turn.times.end)
  return { [`${tool}-first`]: calls.slice(0, 1), [tool]: calls.slice(1), [`${tool}-turn`]: whole === undefined ? [] : [whole] }
}

/**
 * The template home of a scenario: the installed home with the chat's folder, and for `stock` the stock rows.
 * @param context - the suite context.
 * @param scenario - the scenario.
 * @returns the template's root.
 */
function scenarioTemplate(context: SuiteContext, scenario: 'delorun' | 'stock'): Promise<BenchRoot> {
  const chats = context.options.chatsSmall
  return templateHome(context, `chats-${String(chats)}-turn-${scenario}`, chats, (root) => {
    mkdirSync(join(root.home, PROJECT_DIRECTORY), { recursive: true })
    writeFileSync(join(root.home, PROJECT_DIRECTORY, READ_FILE), 'A small file the benchmark reads.\n'.repeat(20))
    if (scenario === 'stock') {
      const bundle = readFileSync(join(runtimeDirectory(root, INSTALLED_VERSION), 'app/node_modules/@delo/bundle-local/cordis.patch.yml'), 'utf8')
      appendFileSync(join(root.deloHome, 'profiles', PROFILE, 'cordis.patch.yml'), stockPatch(switchRows(bundle)))
    }
  })
}

/**
 * One repetition: start the home against the stub, then the chat's four turns.
 * @param home - the home copied from the template.
 * @param stub - the model stub.
 * @returns each item's samples.
 */
async function repetition(home: InstalledHome, stub: ModelStub): Promise<Record<string, number[]>> {
  const { link } = await startForLink(home, { DEEPSEEK_BASE_URL: stub.baseURL })
  const client = await openStudio(link)
  try {
    const sessionId = sessionIdOf(await client.call('session/create', { cwd: join(home.root.home, PROJECT_DIRECTORY) }))
    await client.follow(sessionId)
    const turn = async (label: string, toolCalls: number, tool: ScriptedTool): Promise<FinishedTurn> => {
      stub.script(turnScript(toolCalls, tool, ANSWER, label))
      const { sentAt, times } = await client.turn(sessionId, `Benchmark turn ${label}.`, TURN_TIMEOUT_MS)
      const finished = { sentAt, times, requests: stub.exchanges.filter(exchange => exchange.turn && exchange.arrivedAt >= sentAt) }
      checkTurn(finished, toolCalls, label)
      return finished
    }
    const items: Record<string, number[]> = {}
    const add = (values: Record<string, number | number[]>): void => {
      for (const [item, value] of Object.entries(values)) items[item] = [...items[item] ?? [], ...Array.isArray(value) ? value : [value]]
    }
    add(textItems(await turn('cold', 0, TOOLS.read), true))
    add(textItems(await turn('warm', 0, TOOLS.read), false))
    add(toolItems(await turn('read', TOOL_CALLS, TOOLS.read), 'read'))
    add(toolItems(await turn('write', TOOL_CALLS, TOOLS.write), 'write'))
    return items
  } finally {
    client.close()
  }
}

/**
 * Run one scenario's repetitions.
 * @param context - the suite context.
 * @param scenario - the scenario.
 * @returns its result.
 */
async function runScenario(context: SuiteContext, scenario: (typeof TURN_SCENARIOS)[number]): Promise<ScenarioResult> {
  const fixtures = await context.fixtures()
  const template = await scenarioTemplate(context, scenario.id)
  fixtures.channel.serve(await installedChannel(fixtures))
  const samples = new Samples()
  const failures: string[] = []
  let completed = 0
  for (let index = 0; index < context.options.repeat; index++) {
    context.log(`turn/${scenario.id}: repetition ${String(index + 1)} of ${String(context.options.repeat)}`)
    const root = context.newRoot()
    const home: InstalledHome = { root, launcher: fixtures.channel.launcher }
    const stub = await startModelStub()
    try {
      copyHome(template, root)
      for (const [item, values] of Object.entries(await repetition(home, stub))) for (const value of values) samples.add(item, value)
      completed++
    } catch (error) {
      failures.push(context.scrubber.scrub(error instanceof Error ? error.message : String(error)))
    } finally {
      await stopHome(home).catch(() => killLeftovers(root))
      await stub.close()
      root.dispose()
    }
  }
  return { scenario: scenario.id, description: scenario.description, parameters: { chats: context.options.chatsSmall, toolCalls: TOOL_CALLS, model: 'loopback stub' }, completed, phases: samples.results(Object.keys(TURN_ITEMS)), failures }
}

/** The suite. */
export const turnSuite: Suite = {
  id: 'turn',
  title: 'A chat turn and its tool calls, around the model',
  items: TURN_ITEMS,
  scenarios: TURN_SCENARIOS,
  async run(context: SuiteContext, selected: readonly string[]): Promise<SuiteResult> {
    const scenarios: ScenarioResult[] = []
    for (const scenario of TURN_SCENARIOS.filter(candidate => selected.includes(candidate.id))) scenarios.push(await runScenario(context, scenario))
    return {
      suite: 'turn',
      scenarios,
      skipped: [
        { item: 'the model\'s own time', reason: 'the loopback stub answers at once, so every item is Delo\'s and the provider adapter\'s time around the model' },
        { item: 'a tool call that asks the person', reason: 'no read-only or in-folder call asks in either composition; an approval waits on a person, not on Delo' },
      ],
    }
  },
}
