/**
 * The releases and template homes suites share within a run: release `0.1.0`, which every installed home starts on,
 * its channel, and template homes installed from it once and copied into each repetition's root.
 *
 * @module @delorun/benchmarks/fixtures/releases
 */
import type { BenchRoot } from '../harness/roots.ts'
import type { SharedFixtures, SuiteContext } from '../harness/suite.ts'
import { addChats, chatCorpus } from './data.ts'
import { installHome } from './home.ts'

/** The release every installed home starts on. */
export const INSTALLED_VERSION = '0.1.0'

/**
 * The channel that names {@link INSTALLED_VERSION}.
 * @param fixtures - the run's fixtures.
 * @returns the channel directory.
 */
export async function installedChannel(fixtures: SharedFixtures): Promise<string> {
  return fixtures.channel.publish('installed', [await fixtures.closure(INSTALLED_VERSION, 'base')])
}

/**
 * A template home: {@link INSTALLED_VERSION} installed by the run's launcher, set up, with a synthetic chat set, and then
 * whatever `customize` adds. Made once per key and run.
 * @param context - the suite context.
 * @param key - the template's key; one template per key.
 * @param chats - how many synthetic chats it holds.
 * @param customize - adds to the home after install.
 * @returns the template's root, which suites copy and never change.
 */
export async function templateHome(context: SuiteContext, key: string, chats: number, customize: (root: BenchRoot) => void | Promise<void> = () => {}): Promise<BenchRoot> {
  const fixtures = await context.fixtures()
  return fixtures.template(key, async (root) => {
    context.log(`installing the template home ${key}`)
    fixtures.channel.serve(await installedChannel(fixtures))
    await installHome(root, fixtures.channel.launcher, INSTALLED_VERSION)
    addChats(await chatCorpus(context.cache, chats, context.log), root.delorunHome)
    await customize(root)
  })
}
