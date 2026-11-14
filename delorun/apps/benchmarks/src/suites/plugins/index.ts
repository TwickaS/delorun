/**
 * The plugins suite: how long a person waits to install, turn off, turn on and reload a plugin, and what each installed
 * plugin adds to a start. Every repetition copies an installed template home and works through the launcher as a
 * person runs `delorun`; the plugins are synthetic local packages ([packages](./packages.ts)) whose one row reports its
 * start and stop in the home log.
 *
 * - `lifecycle`: with Delorun running, `delorun plugin --profile default add <tarball> --offline --ignore-scripts`
 *   installs one plugin, timed to the command's exit and to its row starting, which the Host's profile watcher does
 *   when the install adds the bundle to the profile's bundle list. The row is then turned off, on and reloaded through
 *   the profile's own patch file, the person's layer that the Host's profile watcher applies live: a row
 *   `{ id, disabled: true }`, as the studio's plugin manager writes it to turn a plugin off; removing that row again;
 *   and a row that changes the row's configuration, which restarts it. Each is timed from the write to the row's report.
 * - `start-0`, `start-5`, `start-20`: the first `delorun start` of a copied home with that many installed plugins, to
 *   the command's exit, to the studio's index answering and to the last plugin's row starting, so the per-plugin start
 *   cost reads as the difference between the scenarios.
 *
 * pnpm runs offline from the closure's own copy, so nothing reaches a registry: a dependency-free local tarball needs
 * none.
 *
 * @module @delorun/benchmarks/suites/plugins
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readLines, resolveSurface } from '@delorun/logs'
import { copyHome, delorun, delorunRequest, PROFILE, runtimeDirectory, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { INSTALLED_VERSION, installedChannel, templateHome } from '../../fixtures/releases.ts'
import { expectSuccess, run, type Finished } from '../../harness/processes.ts'
import { Samples, type ScenarioResult, type SuiteResult } from '../../harness/result.ts'
import type { BenchRoot } from '../../harness/roots.ts'
import type { Suite, SuiteContext } from '../../harness/suite.ts'
import { studioAnswered } from '../start/index.ts'
import {
  allStarted, configOverride, disabledOverride, firstEvent, loadedPluginFiles, loadedPluginRowId, loadedPluginTarballName,
  packageTarball, pluginEventsIn, pnpmEntry, pnpmShim, withRows, type PluginEvent,
} from './packages.ts'

/** How long a row may take to report after the change that should start or stop it. */
const EVENT_TIMEOUT_MS = 120_000

/** The suite's items. */
export const PLUGINS_ITEMS: Readonly<Record<string, string>> = {
  'install': '`delorun plugin --profile default add <tarball> --offline --ignore-scripts` with Delorun running, from start to exit',
  'install:loaded': 'The same install, from its start to the new plugin\'s row reporting started',
  'disable': 'A profile patch row `disabled: true` for the plugin\'s row, from the write to the row reporting stopped',
  'enable': 'Removing that patch row again, from the write to the row reporting started',
  'reload': 'A profile patch row that changes the row\'s configuration, from the write to the row reporting started with it',
  'start': 'The first `delorun start` of a copied home, from start to the command reporting Delorun running',
  'start:studio': 'The first `delorun start`, from start to the studio\'s index answering',
  'start:plugins': 'The first `delorun start`, from start to the last installed plugin\'s row reporting started',
}

/** The installed-plugin counts of the start scenarios. */
export const START_PLUGIN_COUNTS: readonly number[] = [0, 5, 20]

/** The scenarios. */
export const PLUGINS_SCENARIOS: readonly { readonly id: string, readonly description: string }[] = [
  { id: 'lifecycle', description: 'One synthetic plugin installed from a local tarball into a running home with the small chat set, then turned off, on and reloaded through the profile patch' },
  ...START_PLUGIN_COUNTS.map(count => ({ id: `start-${String(count)}`, description: `The first start of a copied home with the small chat set and ${String(count)} installed synthetic plugins that each load one row` })),
]

/**
 * Write the tarballs of the first `count` synthetic plugins into a directory.
 * @param directory - the directory, created when missing.
 * @param count - how many.
 * @returns each tarball's path, by index.
 */
export function writePluginTarballs(directory: string, count: number): readonly string[] {
  mkdirSync(directory, { recursive: true })
  return Array.from({ length: count }, (_, index) => {
    const path = join(directory, loadedPluginTarballName(index))
    writeFileSync(path, packageTarball(loadedPluginFiles(index)))
    return path
  })
}

/**
 * Write a `pnpm` that runs an installed runtime's pnpm with that runtime's Node.
 * @param runtime - the installed runtime's directory.
 * @param directory - where to write it, created when missing.
 * @returns the directory, to put first on `PATH`.
 */
export function writePnpmShim(runtime: string, directory: string): string {
  const entry = pnpmEntry(JSON.parse(readFileSync(join(runtime, 'pnpm', 'package.json'), 'utf8')))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'pnpm'), pnpmShim(join(runtime, 'node', 'bin', 'node'), join(runtime, 'pnpm', entry)))
  chmodSync(join(directory, 'pnpm'), 0o755)
  return directory
}

/**
 * The synthetic rows' reports in a home log.
 * @param delorunHome - the Delorun home.
 * @param since - records before this time are left out.
 * @returns the reports, oldest record first.
 */
export function pluginEvents(delorunHome: string, since: number): readonly PluginEvent[] {
  return readLines(resolveSurface({ kind: 'home', home: delorunHome, profile: PROFILE }), 10_000, line => line.record !== undefined && Date.parse(line.record.ts) >= since)
    .flatMap(({ record }) => pluginEventsIn(record!.msg, Date.parse(record!.ts)))
}

/**
 * Poll until a probe answers.
 * @param probe - answers `undefined` until the awaited thing happened.
 * @param timeoutMs - the deadline.
 * @param what - what is awaited, for the message.
 * @returns the probe's answer.
 * @throws {Error} when it does not answer in time.
 */
export async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const answer = probe()
    if (answer !== undefined) return answer
    if (Date.now() >= deadline) throw new Error(`${what} did not happen within ${String(timeoutMs / 1000)} seconds`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Replace a file by writing a sibling and renaming it over the file, as the studio's plugin manager saves the profile
 * patch.
 * @param path - the file.
 * @param text - its new text.
 */
export function replaceFile(path: string, text: string): void {
  const temporary = `${path}.benchmark-${String(process.pid)}`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Install plugin tarballs into a home's CLI profile through the launcher, with the closure's pnpm first on `PATH`.
 * @param home - the home.
 * @param tarballs - the tarballs.
 * @returns how the command finished.
 */
async function installPlugins(home: InstalledHome, tarballs: readonly string[]): Promise<Finished> {
  const bin = writePnpmShim(runtimeDirectory(home.root, INSTALLED_VERSION), join(home.root.path, 'pnpm-bin'))
  const request = delorunRequest(home, ['plugin', '--profile', PROFILE, 'add', ...tarballs, '--offline', '--ignore-scripts'], 300_000)
  return expectSuccess(await run({ ...request, env: { ...request.env, PATH: `${bin}:${String(request.env.PATH)}` } }), 'the plugin install')
}

/**
 * Change the profile patch and time the first plugin's row reporting the change.
 * @param delorunHome - the Delorun home.
 * @param text - the patch's new text.
 * @param event - the awaited report.
 * @param generation - its generation.
 * @returns the milliseconds from the write to the report.
 */
async function patched(delorunHome: string, text: string, event: PluginEvent['event'], generation: number): Promise<number> {
  const since = Date.now()
  replaceFile(join(delorunHome, 'profiles', PROFILE, 'cordis.patch.yml'), text)
  return await waitFor(() => firstEvent(pluginEvents(delorunHome, since), 0, event, generation), EVENT_TIMEOUT_MS, `the plugin row reporting ${event} ${String(generation)}`) - since
}

/**
 * One `lifecycle` repetition.
 * @param home - the home, copied from the template.
 * @returns the items.
 */
async function lifecycle(home: InstalledHome): Promise<Record<string, number>> {
  const delorunHome = home.root.delorunHome
  const [tarball] = writePluginTarballs(join(home.root.path, 'plugin-packages'), 1)
  const started = expectSuccess(await delorun(home, ['start'], 300_000), '`delorun start`')
  await studioAnswered(delorunHome, started.startedAt)
  const install = await installPlugins(home, [tarball!])
  const loaded = await waitFor(() => firstEvent(pluginEvents(delorunHome, install.startedAt), 0, 'started', 1), EVENT_TIMEOUT_MS, 'the installed plugin\'s row starting')
  const original = readFileSync(join(delorunHome, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8')
  const id = loadedPluginRowId(0)
  return {
    'install': install.endedAt - install.startedAt,
    'install:loaded': loaded - install.startedAt,
    'disable': await patched(delorunHome, withRows(original, disabledOverride(id)), 'stopped', 1),
    'enable': await patched(delorunHome, original, 'started', 1),
    'reload': await patched(delorunHome, withRows(original, configOverride(id, 2)), 'started', 2),
  }
}

/**
 * One start repetition.
 * @param home - the home, copied from a template with `count` installed plugins.
 * @param count - how many.
 * @returns the items.
 */
async function firstStart(home: InstalledHome, count: number): Promise<Record<string, number>> {
  const delorunHome = home.root.delorunHome
  const started = expectSuccess(await delorun(home, ['start'], 300_000), '`delorun start`')
  const items: Record<string, number> = { 'start': started.endedAt - started.startedAt }
  items['start:studio'] = await studioAnswered(delorunHome, started.startedAt) - started.startedAt
  if (count > 0) items['start:plugins'] = await waitFor(() => allStarted(pluginEvents(delorunHome, started.startedAt), count), EVENT_TIMEOUT_MS, `all ${String(count)} plugin rows starting`) - started.startedAt
  return items
}

/**
 * The template home of a start scenario: the small chat set and `count` installed plugins, the plugin-free one shared
 * with the other suites.
 * @param context - the suite context.
 * @param count - how many plugins.
 * @returns the template's root.
 */
async function startTemplate(context: SuiteContext, count: number): Promise<BenchRoot> {
  const small = context.options.chatsSmall
  if (count === 0) return templateHome(context, `chats-${String(small)}-plugins-none`, small)
  const { channel } = await context.fixtures()
  return templateHome(context, `chats-${String(small)}-plugins-loaded-${String(count)}`, small, async (root) => {
    await installPlugins({ root, launcher: channel.launcher }, writePluginTarballs(join(root.path, 'plugin-packages'), count))
  })
}

/** The suite. */
export const pluginsSuite: Suite = {
  id: 'plugins',
  title: 'Installing, turning off, turning on and reloading a plugin, and the start cost per installed plugin',
  items: PLUGINS_ITEMS,
  scenarios: PLUGINS_SCENARIOS,
  async run(context: SuiteContext, selected: readonly string[]): Promise<SuiteResult> {
    const fixtures = await context.fixtures()
    const results: ScenarioResult[] = []
    for (const scenario of PLUGINS_SCENARIOS.filter(candidate => selected.includes(candidate.id))) {
      const count = scenario.id === 'lifecycle' ? undefined : Number(scenario.id.slice('start-'.length))
      const template = await startTemplate(context, count ?? 0)
      fixtures.channel.serve(await installedChannel(fixtures))
      const samples = new Samples()
      const failures: string[] = []
      let completed = 0
      for (let index = 0; index < context.options.repeat; index++) {
        context.log(`plugins/${scenario.id}: repetition ${String(index + 1)} of ${String(context.options.repeat)}`)
        const root = context.newRoot()
        const home: InstalledHome = { root, launcher: fixtures.channel.launcher }
        try {
          copyHome(template, root)
          samples.addAll(count === undefined ? await lifecycle(home) : await firstStart(home, count))
          completed++
        } catch (error) {
          failures.push(context.scrubber.scrub(error instanceof Error ? error.message : String(error)))
        } finally {
          await stopHome(home)
          root.dispose()
        }
      }
      results.push({ scenario: scenario.id, description: scenario.description, parameters: { chats: context.options.chatsSmall, plugins: count ?? 1 }, completed, phases: samples.results(Object.keys(PLUGINS_ITEMS)), failures })
    }
    return {
      suite: 'plugins',
      scenarios: results,
      skipped: [
        { item: 'installing from a registry', reason: 'the isolated network reaches no registry; a local tarball is installed offline with the closure\'s pnpm' },
        { item: 'the studio\'s plugin manager', reason: 'it calls the Host\'s remote plugin-manager methods from a signed-in browser session; the suite makes the same profile changes through `delorun plugin` and the profile patch, which the Host\'s profile watcher applies' },
      ],
    }
  },
}
