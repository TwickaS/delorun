/**
 * The install suite: a person's first run of the launcher on a machine with no Delorun, to a studio they can open. Each
 * repetition starts from an empty home and runs, through the run's launcher, `delorun --version` (the install: resolve
 * the channel, verify the signature and the log, download and unpack, then the runtime's first start), then
 * setup unattended (`delorun setup --yes`, the answers a person takes by accepting every default), then the first
 * `delorun start` to the studio's first page. The install's steps are read from the times the launcher's progress
 * lines arrived; the launcher prints each line when its step finishes, except the download line, which it prints as
 * the download begins, and the unpack line ends the download and starts the store's install.
 *
 * @module @delorun/benchmarks/suites/install
 */
import { firstMatch, expectSuccess, type Finished } from '../../harness/processes.ts'
import { Samples, type ScenarioResult, type SuiteResult } from '../../harness/result.ts'
import type { Suite, SuiteContext } from '../../harness/suite.ts'
import { delorun, patchStudioPort, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { INSTALLED_VERSION, installedChannel } from '../../fixtures/releases.ts'
import { difference } from '../update/index.ts'
import { studioAnswered } from '../start/index.ts'

/** The suite's items. */
export const INSTALL_ITEMS: Readonly<Record<string, string>> = {
  'install': 'The launcher\'s first run with no runtime installed, from start to the installed runtime\'s `--version` exiting',
  'install:resolve': 'From start to the channel resolved: the launcher\'s start, the timestamp and the root chain',
  'install:signature': 'Fetching the manifest and its log bundle and verifying the signature',
  'install:log': 'The release-log check',
  'install:download': 'From the download beginning to the store installing: download, archive check and unpack',
  'install:store-and-start': 'From the store installing to the runtime\'s first output: the move into the store, the start check and the runtime\'s start',
  'setup': 'Setup with every default accepted (`delorun setup --yes`), from start to exit',
  'first-start': 'The first `delorun start`, from start to the command reporting Delorun running',
  'first-start:studio': 'The first `delorun start`, from start to the studio\'s index answering',
  'install-to-studio': 'The sum a new person waits through: install, setup and the first start to the studio\'s index',
}

/**
 * The install's items, from the launcher's progress lines.
 * @param finished - the launcher's first run.
 * @returns each item that could be measured.
 */
export function installItems(finished: Finished): Record<string, number> {
  const at = (pattern: RegExp): number | undefined => firstMatch(finished.lines, pattern)?.at
  const resolved = at(/^✔ Found release /u)
  const signature = at(/^✔ Signature checked/u)
  const log = at(/^[✔!] Release log /u)
  const download = at(/^Downloading /u)
  const installing = at(/^✔ Unpacked the runtime/u)
  const version = at(/^Delorun \d/u)
  const items: Record<string, number | undefined> = {
    'install': finished.endedAt - finished.startedAt,
    'install:resolve': difference(finished.startedAt, resolved),
    'install:signature': difference(resolved, signature),
    'install:log': difference(signature, log),
    'install:download': difference(download, installing),
    'install:store-and-start': difference(installing, version),
  }
  return Object.fromEntries(Object.entries(items).filter((entry): entry is [string, number] => entry[1] !== undefined))
}

/** The suite. */
export const installSuite: Suite = {
  id: 'install',
  title: 'Install, setup and the first start',
  items: INSTALL_ITEMS,
  scenarios: [{ id: 'first-run', description: 'An empty home: the launcher installs the channel\'s release, setup runs unattended, and Delorun starts for the first time' }],
  async run(context: SuiteContext): Promise<SuiteResult> {
    const fixtures = await context.fixtures()
    fixtures.channel.serve(await installedChannel(fixtures))
    const samples = new Samples()
    const failures: string[] = []
    let completed = 0
    for (let index = 0; index < context.options.repeat; index++) {
      context.log(`install/first-run: repetition ${String(index + 1)} of ${String(context.options.repeat)}`)
      const root = context.newRoot()
      const home: InstalledHome = { root, launcher: fixtures.channel.launcher }
      try {
        const install = expectSuccess(await delorun(home, ['--version'], 900_000), 'the launcher\'s install')
        const setup = expectSuccess(await delorun(home, ['setup', '--yes'], 900_000), '`delorun setup --yes`')
        patchStudioPort(root, INSTALLED_VERSION)
        const start = expectSuccess(await delorun(home, ['start'], 300_000), '`delorun start`')
        const studio = await studioAnswered(root.delorunHome, start.startedAt)
        samples.addAll({
          ...installItems(install),
          'setup': setup.endedAt - setup.startedAt,
          'first-start': start.endedAt - start.startedAt,
          'first-start:studio': studio - start.startedAt,
          'install-to-studio': (install.endedAt - install.startedAt) + (setup.endedAt - setup.startedAt) + (studio - start.startedAt),
        })
        completed++
      } catch (error) {
        failures.push(context.scrubber.scrub(error instanceof Error ? error.message : String(error)))
      } finally {
        await stopHome(home)
        root.dispose()
      }
    }
    const result: ScenarioResult = { scenario: 'first-run', description: installSuite.scenarios[0]!.description, parameters: { version: INSTALLED_VERSION }, completed, phases: samples.results(Object.keys(INSTALL_ITEMS)), failures }
    return {
      suite: 'install',
      scenarios: [result],
      skipped: [
        { item: 'interactive setup', reason: 'its questions need a terminal; `setup --yes` takes the same defaults without one' },
        { item: 'the `~/.dsh` import', reason: 'not on the trunk this run measured' },
      ],
    }
  },
}
