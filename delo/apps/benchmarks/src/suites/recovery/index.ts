/**
 * The recovery suite: the commands a person runs when a start or an update went wrong, each through the launcher with
 * Delo stopped, as `delorun recover` expects: `recover status`, entering safe mode and the start in safe mode to the
 * studio's first page, leaving safe mode, and restoring a profile history version. The version restored is the
 * oldest the home's history lists, which setup wrote.
 *
 * @module @delo/benchmarks/suites/recovery
 */
import { copyHome, delorun, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { installedChannel, templateHome } from '../../fixtures/releases.ts'
import { expectSuccess, type Finished } from '../../harness/processes.ts'
import { Samples, type ScenarioResult, type SuiteResult } from '../../harness/result.ts'
import type { Suite, SuiteContext } from '../../harness/suite.ts'
import { studioAnswered } from '../start/index.ts'

/** The suite's items. */
export const RECOVERY_ITEMS: Readonly<Record<string, string>> = {
  'recover-status': '`delorun recover status`, from start to exit',
  'safe-mode-enter': '`delorun recover safe-mode`, from start to exit',
  'safe-mode-start': '`delorun start` in safe mode, from start to the command reporting Delo running',
  'safe-mode-start:studio': '`delorun start` in safe mode, from start to the studio\'s index answering',
  'safe-mode-exit': '`delorun recover exit-safe-mode`, from start to exit',
  'restore-version': '`delorun recover restore <version>` of the oldest history version, from start to exit',
}

/**
 * The id of the oldest profile history version `recover status --json` lists.
 * @param finished - the finished `recover status --json`.
 * @returns the id, or `undefined` when the history is empty.
 * @throws {SyntaxError} when the output is not the JSON report.
 */
export function oldestVersion(finished: Pick<Finished, 'lines'>): string | undefined {
  const report = JSON.parse(finished.lines.filter(line => line.stream === 'stdout').map(line => line.text).join('\n')) as { readonly versions?: readonly { readonly id: string }[] }
  return report.versions?.at(-1)?.id
}

/**
 * Run one `delorun` command and require it to succeed.
 * @param home - the home.
 * @param args - the arguments.
 * @returns how it finished.
 */
async function command(home: InstalledHome, args: readonly string[]): Promise<Finished> {
  return expectSuccess(await delorun(home, args, 300_000), `\`delorun ${args.join(' ')}\``)
}

/**
 * The span of a finished command.
 * @param finished - the command.
 * @returns its milliseconds from start to exit.
 */
function span(finished: Finished): number {
  return finished.endedAt - finished.startedAt
}

/** The suite. */
export const recoverySuite: Suite = {
  id: 'recovery',
  title: 'Recovery',
  items: RECOVERY_ITEMS,
  scenarios: [{ id: 'installed', description: 'An installed home with the small chat set, copied for each repetition, with Delo stopped' }],
  async run(context: SuiteContext): Promise<SuiteResult> {
    const fixtures = await context.fixtures()
    const template = await templateHome(context, `chats-${String(context.options.chatsSmall)}-plugins-none`, context.options.chatsSmall)
    fixtures.channel.serve(await installedChannel(fixtures))
    const samples = new Samples()
    const failures: string[] = []
    let completed = 0
    let noHistory = false
    for (let index = 0; index < context.options.repeat; index++) {
      context.log(`recovery/installed: repetition ${String(index + 1)} of ${String(context.options.repeat)}`)
      const root = context.newRoot()
      const home: InstalledHome = { root, launcher: fixtures.channel.launcher }
      try {
        copyHome(template, root)
        samples.add('recover-status', span(await command(home, ['recover', 'status'])))
        samples.add('safe-mode-enter', span(await command(home, ['recover', 'safe-mode', '--reason', 'benchmark'])))
        const start = await command(home, ['start'])
        samples.add('safe-mode-start', span(start))
        samples.add('safe-mode-start:studio', await studioAnswered(root.deloHome, start.startedAt) - start.startedAt)
        await stopHome(home)
        samples.add('safe-mode-exit', span(await command(home, ['recover', 'exit-safe-mode'])))
        const version = oldestVersion(await command(home, ['recover', 'status', '--json']))
        if (version === undefined) noHistory = true
        else samples.add('restore-version', span(await command(home, ['recover', 'restore', version])))
        completed++
      } catch (error) {
        failures.push(context.scrubber.scrub(error instanceof Error ? error.message : String(error)))
      } finally {
        await stopHome(home)
        root.dispose()
      }
    }
    const result: ScenarioResult = { scenario: 'installed', description: recoverySuite.scenarios[0]!.description, parameters: { chats: context.options.chatsSmall }, completed, phases: samples.results(Object.keys(RECOVERY_ITEMS)), failures }
    const skipped = [{ item: 'rollback', reason: 'measured by the update suite, which has an update to roll back' }]
    if (noHistory) skipped.push({ item: 'restore-version', reason: 'the profile history of a home that `delorun setup --yes` set up lists no version, so there is none to restore' })
    return { suite: 'recovery', scenarios: [result], skipped }
  },
}
