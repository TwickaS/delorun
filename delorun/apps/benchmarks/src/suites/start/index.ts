/**
 * The start suite: how long a person waits for Delorun to run and for the studio to answer. Each repetition copies an
 * installed home, so its first start is the first start of that home, and then runs the start-and-stop commands a
 * person runs, each through the launcher:
 *
 * - `delorun start` the first time (cold) and again (warm), each to the command's exit, which `delorun start` reaches
 *   when the home process reports `running`, and to the studio's web server answering its index;
 * - `delorun stop` and `delorun stop --now`;
 * - a restart: `delorun stop` then `delorun start`.
 *
 * A bare `delorun` is not measured: it opens the default browser, which on WSL is the person's own Windows browser.
 * The studio suite measures the page in a headless browser.
 *
 * @module @delorun/benchmarks/suites/start
 */
import { readLines, resolveSurface } from '@delorun/logs'
import { copyHome, delorun, delorunRequest, PROFILE, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { installedChannel, templateHome } from '../../fixtures/releases.ts'
import { expectSuccess, run, type Finished } from '../../harness/processes.ts'
import { Samples, type ScenarioResult, type SuiteResult } from '../../harness/result.ts'
import type { Suite, SuiteContext } from '../../harness/suite.ts'

/** How long the studio may take to answer after the start command exited. */
const STUDIO_TIMEOUT_MS = 120_000

/** The suite's items. */
export const START_ITEMS: Readonly<Record<string, string>> = {
  'start-cold': 'The first `delorun start` of a home, from start to the command reporting Delorun running',
  'start-cold:studio': 'The first `delorun start`, from start to the studio\'s web server answering its index',
  'stop': '`delorun stop`, from start to exit',
  'start-warm': 'A later `delorun start`, from start to the command reporting Delorun running',
  'start-warm:studio': 'A later `delorun start`, from start to the studio\'s web server answering its index',
  'stop-now': '`delorun stop --now`, from start to exit',
  'restart': '`delorun stop` and then `delorun start`, from the stop starting to the start reporting Delorun running',
}

/**
 * The studio's origin, read from the line the Host printed into the home log, whose start token the log redacts.
 * @param delorunHome - the Delorun home.
 * @param since - records before this time belong to an earlier start.
 * @returns the origin, or `undefined` while the Host has not printed it.
 */
export function studioOrigin(delorunHome: string, since: number): string | undefined {
  const lines = readLines(resolveSurface({ kind: 'home', home: delorunHome, profile: PROFILE }), 10_000, line => line.record !== undefined && Date.parse(line.record.ts) >= since)
  for (const { record } of lines) {
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(record!.msg)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * Wait until the studio's web server answers its index: 200 with a session, or 401 to a browser without one, which a
 * started Host answers only once every row has settled.
 * @param delorunHome - the Delorun home.
 * @param since - the start command's start.
 * @returns when it answered, in epoch milliseconds.
 * @throws {Error} when it does not answer in time.
 */
export async function studioAnswered(delorunHome: string, since: number): Promise<number> {
  const deadline = Date.now() + STUDIO_TIMEOUT_MS
  let last = 'no studio address in the home log'
  while (Date.now() < deadline) {
    const origin = studioOrigin(delorunHome, since)
    if (origin !== undefined) {
      try {
        const index = await fetch(`${origin}/`)
        await index.body?.cancel()
        if (index.status === 200 || index.status === 401) return Date.now()
        last = `the index answered ${String(index.status)}`
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`the studio did not answer within ${String(STUDIO_TIMEOUT_MS / 1000)} seconds: ${last}`)
}

/** Delorun started, with a fresh sign-in link to its studio. */
export interface LinkedStart {
  /** The sign-in link `delorun open --print` printed. */
  readonly link: string
  /** When the start command started. */
  readonly startedAt: number
}

/**
 * The sign-in link in `delorun open --print`'s output.
 * @param lines - the output's lines.
 * @returns the link, or `undefined`.
 */
export function signInLink(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = /(http:\/\/127\.0\.0\.1:\d+\/\S*)/u.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * Start Delorun with `delorun start`, then ask it for a sign-in link with `delorun open --print`, as a person does on a
 * computer whose browser the benchmark does not drive. No browser opens.
 * @param home - the home.
 * @param env - variables added to the start command's environment.
 * @returns the link and when the start began.
 * @throws {Error} when either command fails or prints no link.
 */
export async function startForLink(home: InstalledHome, env: NodeJS.ProcessEnv = {}): Promise<LinkedStart> {
  const request = delorunRequest(home, ['start'], 300_000)
  const started = expectSuccess(await run({ ...request, env: { ...request.env, ...env } }), '`delorun start`')
  const opened = expectSuccess(await run(delorunRequest(home, ['open', '--print'], 120_000)), '`delorun open --print`')
  const link = signInLink(opened.lines.filter(line => line.stream === 'stdout').map(line => line.text))
  if (link === undefined) throw new Error(`\`delorun open --print\` printed no link:\n${opened.lines.map(line => line.text).join('\n')}`)
  return { link, startedAt: started.startedAt }
}

/**
 * Run a start command and require it to report Delorun running.
 * @param home - the home.
 * @param args - the arguments.
 * @returns how it finished.
 */
async function started(home: InstalledHome, args: readonly string[]): Promise<Finished> {
  return expectSuccess(await run(delorunRequest(home, args, 300_000)), `\`delorun ${args.join(' ')}\``)
}

/**
 * One repetition's items.
 * @param home - the home, copied from the template.
 * @returns the items.
 */
async function repetition(home: InstalledHome): Promise<Record<string, number>> {
  const items: Record<string, number> = {}
  const delorunHome = home.root.delorunHome
  const cold = await started(home, ['start'])
  items['start-cold'] = cold.endedAt - cold.startedAt
  items['start-cold:studio'] = await studioAnswered(delorunHome, cold.startedAt) - cold.startedAt
  const stop = expectSuccess(await delorun(home, ['stop'], 300_000), '`delorun stop`')
  items.stop = stop.endedAt - stop.startedAt
  const warm = await started(home, ['start'])
  items['start-warm'] = warm.endedAt - warm.startedAt
  items['start-warm:studio'] = await studioAnswered(delorunHome, warm.startedAt) - warm.startedAt
  const now = expectSuccess(await delorun(home, ['stop', '--now'], 300_000), '`delorun stop --now`')
  items['stop-now'] = now.endedAt - now.startedAt
  const restartStop = expectSuccess(await delorun(home, ['stop'], 300_000), '`delorun stop`')
  const restartStart = await started(home, ['start'])
  items.restart = restartStart.endedAt - restartStop.startedAt
  return items
}

/** The suite. */
export const startSuite: Suite = {
  id: 'start',
  title: 'Start, stop and the studio\'s first page',
  items: START_ITEMS,
  scenarios: [{ id: 'installed', description: 'An installed home with the small chat set, copied for each repetition so its first start is cold' }],
  async run(context: SuiteContext): Promise<SuiteResult> {
    const fixtures = await context.fixtures()
    const template = await templateHome(context, `chats-${String(context.options.chatsSmall)}-plugins-none`, context.options.chatsSmall)
    fixtures.channel.serve(await installedChannel(fixtures))
    const samples = new Samples()
    const failures: string[] = []
    let completed = 0
    for (let index = 0; index < context.options.repeat; index++) {
      context.log(`start/installed: repetition ${String(index + 1)} of ${String(context.options.repeat)}`)
      const root = context.newRoot()
      const home: InstalledHome = { root, launcher: fixtures.channel.launcher }
      try {
        copyHome(template, root)
        samples.addAll(await repetition(home))
        completed++
      } catch (error) {
        failures.push(context.scrubber.scrub(error instanceof Error ? error.message : String(error)))
      } finally {
        await stopHome(home)
        root.dispose()
      }
    }
    const result: ScenarioResult = { scenario: 'installed', description: startSuite.scenarios[0]!.description, parameters: { chats: context.options.chatsSmall }, completed, phases: samples.results(Object.keys(START_ITEMS)), failures }
    return { suite: 'start', scenarios: [result], skipped: [{ item: 'a bare `delorun`', reason: 'it opens the default browser, which on WSL is the person\'s own Windows browser; the studio suite measures the page in a headless browser' }, { item: 'a cold operating-system file cache', reason: 'dropping the page cache needs root; "cold" is the first start of a freshly copied home, whose files the copy has just read' }] }
  },
}
