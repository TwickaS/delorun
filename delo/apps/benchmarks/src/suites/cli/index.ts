/**
 * The CLI responsiveness suite: the commands a person runs often and expects to answer at once, each run through the
 * launcher as a person runs `delorun`, timed to its first output and to its exit. The cost of starting processes is
 * measured beside them, so a command's own work reads as its time minus the start cost: a bare Node start, the
 * launcher alone (`--help`, which starts no runtime), and `--version` run by the runtime's own Node without the
 * launcher's start check. Every repetition runs every command once in the same home, so the first repetition is the
 * first run after install.
 *
 * @module @delo/benchmarks/suites/cli
 */
import { join } from 'node:path'
import { copyHome, delorun, deloEnvironment, PROFILE, runtimeDirectory, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { INSTALLED_VERSION, installedChannel, templateHome } from '../../fixtures/releases.ts'
import { expectSuccess, run, type Finished } from '../../harness/processes.ts'
import { Samples, type ScenarioResult, type SuiteResult } from '../../harness/result.ts'
import type { Suite, SuiteContext } from '../../harness/suite.ts'

/** One measured command. */
interface CliCommand {
  /** The item's id. */
  readonly id: string
  /** The arguments for `delorun`. */
  readonly args: readonly string[]
  /** Whether the home process runs while it is measured. */
  readonly running: boolean
}

/** The commands, in the order each repetition runs them. */
export const CLI_COMMANDS: readonly CliCommand[] = [
  { id: 'version', args: ['--version'], running: false },
  { id: 'status-stopped', args: ['status'], running: false },
  { id: 'doctor', args: ['doctor'], running: false },
  { id: 'verify-offline', args: ['verify', '--offline'], running: false },
  { id: 'trash-list', args: ['trash', 'list'], running: false },
  { id: 'recover-status', args: ['recover', 'status'], running: false },
  { id: 'plugin-list', args: ['plugin', 'list'], running: false },
  { id: 'logs', args: ['logs'], running: false },
  { id: 'status-running', args: ['status'], running: true },
  { id: 'update-check-current', args: ['update', '--check'], running: true },
  { id: 'trash-list-running', args: ['trash', 'list'], running: true },
]

/** The suite's items: for each command its first output and its exit, and the start costs. */
export const CLI_ITEMS: Readonly<Record<string, string>> = {
  'node-start': 'A bare `node -e ""` with the Node that runs the launcher: the floor under every command',
  'launcher-only': 'The launcher with `--help`, which prints its usage and starts no runtime',
  'runtime-version-direct': '`delorun --version` run by the runtime\'s own Node, without the launcher\'s start check',
  ...Object.fromEntries(CLI_COMMANDS.flatMap(command => [
    [`${command.id}:first-output`, `\`delorun ${command.args.join(' ')}\`${command.running ? ' with Delo running' : ''}: from start to its first output`],
    [`${command.id}:exit`, `\`delorun ${command.args.join(' ')}\`${command.running ? ' with Delo running' : ''}: from start to exit`],
  ])),
}

/**
 * The items of one finished command.
 * @param id - the command's id.
 * @param finished - how it finished.
 * @returns its first output and exit times.
 */
export function commandItems(id: string, finished: Finished): Record<string, number> {
  return {
    ...finished.firstOutputAt === undefined ? {} : { [`${id}:first-output`]: finished.firstOutputAt - finished.startedAt },
    [`${id}:exit`]: finished.endedAt - finished.startedAt,
  }
}

/**
 * Run a command and require it to succeed.
 * @param home - the home.
 * @param command - the command.
 * @returns how it finished.
 */
async function measured(home: InstalledHome, command: CliCommand): Promise<Finished> {
  return expectSuccess(await delorun(home, command.args, 300_000), `\`delorun ${command.args.join(' ')}\``)
}

/** The suite. */
export const cliSuite: Suite = {
  id: 'cli',
  title: 'CLI responsiveness',
  items: CLI_ITEMS,
  scenarios: [{ id: 'installed', description: 'The commands of an installed home with the small chat set, each run once per repetition, first with Delo stopped and then running' }],
  async run(context: SuiteContext): Promise<SuiteResult> {
    const fixtures = await context.fixtures()
    const template = await templateHome(context, `chats-${String(context.options.chatsSmall)}-plugins-none`, context.options.chatsSmall)
    const root = context.newRoot()
    const home: InstalledHome = { root, launcher: fixtures.channel.launcher }
    copyHome(template, root)
    fixtures.channel.serve(await installedChannel(fixtures))
    const samples = new Samples()
    const failures: string[] = []
    let completed = 0
    const runtime = runtimeDirectory(root, INSTALLED_VERSION)
    try {
      for (let repetition = 0; repetition < context.options.repeat; repetition++) {
        context.log(`cli/installed: repetition ${String(repetition + 1)} of ${String(context.options.repeat)}`)
        try {
          const node = await run({ command: process.execPath, args: ['-e', ''], env: deloEnvironment(root), cwd: root.home, timeoutMs: 60_000 })
          samples.add('node-start', node.endedAt - node.startedAt)
          const launcher = expectSuccess(await delorun(home, ['--help'], 60_000), 'the launcher\'s --help')
          samples.add('launcher-only', launcher.endedAt - launcher.startedAt)
          const direct = expectSuccess(await run({
            command: join(runtime, 'node', 'bin', 'node'),
            args: [join(runtime, 'app/node_modules/@delo/cli/src/bin.js'), '--version'],
            env: { ...deloEnvironment(root), DSH_HOME: root.deloHome, DELO_HOME: root.deloHome, DELO_PROFILE: PROFILE },
            cwd: root.home,
            timeoutMs: 60_000,
          }), 'the runtime\'s own --version')
          samples.add('runtime-version-direct', direct.endedAt - direct.startedAt)
          for (const command of CLI_COMMANDS.filter(candidate => !candidate.running)) samples.addAll(commandItems(command.id, await measured(home, command)))
          expectSuccess(await delorun(home, ['start'], 300_000), '`delorun start`')
          for (const command of CLI_COMMANDS.filter(candidate => candidate.running)) samples.addAll(commandItems(command.id, await measured(home, command)))
          await stopHome(home)
          completed++
        } catch (error) {
          failures.push(context.scrubber.scrub(error instanceof Error ? error.message : String(error)))
          await stopHome(home)
        }
      }
    } finally {
      root.dispose()
    }
    const result: ScenarioResult = { scenario: 'installed', description: cliSuite.scenarios[0]!.description, parameters: { chats: context.options.chatsSmall }, completed, phases: samples.results(Object.keys(CLI_ITEMS)), failures }
    return { suite: 'cli', scenarios: [result], skipped: [{ item: '`delorun verify` online', reason: 'it asks the release log the trusted root names, which the isolated network cannot reach; `verify --offline` is measured instead' }] }
  },
}
