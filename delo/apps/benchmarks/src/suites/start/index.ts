/**
 * The start suite: how long a person waits for Delo to run and for the studio to answer. Each repetition copies an
 * installed home, so its first start is the first start of that home, and then runs the start-and-stop commands a
 * person runs, each through the launcher:
 *
 * - `delorun start` the first time (cold) and again (warm), each to the command's exit, which `delorun start` reaches
 *   when the home process reports `running`, and to the studio's first page: its index answering with 200 to a
 *   browser holding the start link's cookie;
 * - `delorun stop` and `delorun stop --now`;
 * - a restart: `delorun stop` then `delorun start`;
 * - a bare `delorun`, which starts Delo and opens the studio; the browser it opens is a stand-in that records the
 *   address and exits, because no browser runs in the isolated network.
 *
 * @module @delo/benchmarks/suites/start
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readLines, resolveSurface } from '@delo/logs'
import { copyHome, delorun, deloRequest, PROFILE, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { installedChannel, templateHome } from '../../fixtures/releases.ts'
import { expectSuccess, run, type Finished } from '../../harness/processes.ts'
import { Samples, type ScenarioResult, type SuiteResult } from '../../harness/result.ts'
import type { Suite, SuiteContext } from '../../harness/suite.ts'

/** How long the studio may take to answer after the start command exited. */
const STUDIO_TIMEOUT_MS = 120_000

/** The suite's items. */
export const START_ITEMS: Readonly<Record<string, string>> = {
  'start-cold': 'The first `delorun start` of a home, from start to the command reporting Delo running',
  'start-cold:studio': 'The first `delorun start`, from start to the studio\'s index answering a browser that holds the start link',
  'stop': '`delorun stop`, from start to exit',
  'start-warm': 'A later `delorun start`, from start to the command reporting Delo running',
  'start-warm:studio': 'A later `delorun start`, from start to the studio\'s index answering',
  'stop-now': '`delorun stop --now`, from start to exit',
  'bare': 'A bare `delorun`, which starts Delo and opens the studio, from start to exit',
  'bare:browser': 'A bare `delorun`, from start to the browser being asked to open the studio',
  'bare:studio': 'A bare `delorun`, from start to the studio\'s index answering',
  'restart': '`delorun stop` and then `delorun start`, from the stop starting to the start reporting Delo running',
}

/**
 * The studio's start link: the address with its one-time token that the Host printed, read from the home log.
 * @param deloHome - the Delo home.
 * @param since - records before this time belong to an earlier start.
 * @returns the link, or `undefined` while the Host has not printed it.
 */
export function studioLink(deloHome: string, since: number): string | undefined {
  const lines = readLines(resolveSurface({ kind: 'home', home: deloHome, profile: PROFILE }), 10_000, line => line.record !== undefined && Date.parse(line.record.ts) >= since)
  for (const { record } of lines) {
    const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/u.exec(record!.msg)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * Wait until the studio's index answers 200 to a browser that opened the start link.
 * @param deloHome - the Delo home.
 * @param since - the start command's start.
 * @returns when it answered, in epoch milliseconds.
 * @throws {Error} when it does not answer in time.
 */
export async function studioAnswered(deloHome: string, since: number): Promise<number> {
  const deadline = Date.now() + STUDIO_TIMEOUT_MS
  let last = 'no start link in the home log'
  while (Date.now() < deadline) {
    const link = studioLink(deloHome, since)
    if (link !== undefined) {
      try {
        const opened = await fetch(link, { redirect: 'manual' })
        const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0]!
        const index = await fetch(new URL('/', link), { headers: { cookie } })
        await index.body?.cancel()
        if (index.status === 200) return Date.now()
        last = `the index answered ${String(index.status)}`
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`the studio did not answer within ${String(STUDIO_TIMEOUT_MS / 1000)} seconds: ${last}`)
}

/**
 * A stand-in browser: a `xdg-open` on the root's `PATH` that records when it was asked and exits.
 * @param directory - where to write it.
 * @returns the directory to put first on `PATH`, and the file it records into.
 */
export function standInBrowser(directory: string): { readonly bin: string, readonly record: string } {
  const bin = join(directory, 'bin')
  const record = join(directory, 'browser-opened')
  mkdirSync(bin, { recursive: true })
  for (const name of ['xdg-open', 'open', 'sensible-browser', 'x-www-browser']) {
    writeFileSync(join(bin, name), `#!/bin/sh\ndate +%s%3N >> '${record}'\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return { bin, record }
}

/**
 * Run a start command and require it to report Delo running.
 * @param home - the home.
 * @param args - the arguments.
 * @param env - extra environment.
 * @returns how it finished.
 */
async function started(home: InstalledHome, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Finished> {
  const request = deloRequest(home, args, 300_000)
  return expectSuccess(await run({ ...request, env: { ...request.env, ...env } }), `\`delorun ${args.join(' ')}\``)
}

/**
 * One repetition's items.
 * @param home - the home, copied from the template.
 * @returns the items.
 */
async function repetition(home: InstalledHome): Promise<Record<string, number>> {
  const items: Record<string, number> = {}
  const deloHome = home.root.deloHome
  const cold = await started(home, ['start'])
  items['start-cold'] = cold.endedAt - cold.startedAt
  items['start-cold:studio'] = await studioAnswered(deloHome, cold.startedAt) - cold.startedAt
  const stop = expectSuccess(await delorun(home, ['stop'], 300_000), '`delorun stop`')
  items.stop = stop.endedAt - stop.startedAt
  const warm = await started(home, ['start'])
  items['start-warm'] = warm.endedAt - warm.startedAt
  items['start-warm:studio'] = await studioAnswered(deloHome, warm.startedAt) - warm.startedAt
  const now = expectSuccess(await delorun(home, ['stop', '--now'], 300_000), '`delorun stop --now`')
  items['stop-now'] = now.endedAt - now.startedAt
  const browser = standInBrowser(home.root.path)
  const request = deloRequest(home, [], 300_000)
  const bare = await started(home, [], { PATH: `${browser.bin}:${String(request.env.PATH)}`, BROWSER: join(browser.bin, 'xdg-open') })
  items.bare = bare.endedAt - bare.startedAt
  items['bare:studio'] = await studioAnswered(deloHome, bare.startedAt) - bare.startedAt
  if (existsSync(browser.record)) items['bare:browser'] = Number(readFileSync(browser.record, 'utf8').split('\n')[0]) - bare.startedAt
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
    return { suite: 'start', scenarios: [result], skipped: [{ item: 'a cold operating-system file cache', reason: 'dropping the page cache needs root; "cold" is the first start of a freshly copied home, whose files the copy has just read' }] }
  },
}
