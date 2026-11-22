/**
 * Run a heavy command inside the machine-wide slot budget that the check runner's runs share (`checks/slots.ts`), so an
 * agent's own builds, compiler runs and focused test runs count against the same CPUs, memory and disk-heavy places:
 *
 * ```sh
 * node_modules/.bin/tsx delorun/apps/tools/src/with-slots.ts [--slots <n>] [--disk] [--memory-gib <n>] -- <command> [args...]
 * ```
 *
 * It waits first come, first served for `--slots` slots (default 4), takes a disk-heavy place with `--disk` (installs, builds,
 * the fork suite), runs the command with the grant in `DELORUN_SLOTS` (a test runner's worker count), releases the slots when
 * the command ends or the wrapper is interrupted, and exits with the command's status. While a machine hold is in force
 * (`run-checks --hold`) it waits, with the hold's reason in its wait report, unless its working directory is inside an allowed
 * worktree.
 *
 * @module @delorun/tools/with-slots
 */
import { spawn } from 'node:child_process'
import { availableParallelism, tmpdir, totalmem } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { cgroupBudget, runMemoryBytes } from './checks/machine.ts'
import { gatePriority, type QueueHost } from './checks/run-queue.ts'
import { machineBudget, nodeSlotHost, privateSlotPaths } from './checks/slot-host.ts'
import { takeSlots, type SlotBudget, type SlotPaths } from './checks/slots.ts'

const GIB = 1024 ** 3
/** The slots a command takes when `--slots` names no count. */
const DEFAULT_SLOTS = 4

/** What the wrapper needs from its process. */
export interface WrapperHost {
  readonly slots: QueueHost
  readonly paths: SlotPaths
  readonly budget: SlotBudget
  readonly env: NodeJS.ProcessEnv
  /** The working directory the command runs in, which a machine hold's allowed worktrees are matched against. */
  readonly cwd?: string
  /**
   * Run the command with the grant and resolve with its exit status.
   * @param argv - the command and its arguments.
   * @param env - its environment.
   * @returns the exit status, 1 for a command ended by a signal or one that did not start.
   */
  readonly run: (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>
}

/**
 * Wait for slots, run the command and give the slots back.
 * @param argv - the wrapper's arguments: options, `--`, then the command.
 * @param host - the slot budget, the environment and the command runner.
 * @returns the command's exit status.
 * @throws Error on a malformed option or a missing command.
 */
export async function withSlots(argv: readonly string[], host: WrapperHost): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { 'slots': { type: 'string' }, 'disk': { type: 'boolean', default: false }, 'memory-gib': { type: 'string' } } })
  const slots = values.slots === undefined ? DEFAULT_SLOTS : Number(values.slots)
  if (!Number.isSafeInteger(slots) || slots < 1) throw new Error(`--slots takes a positive whole number, got ${String(values.slots)}`)
  const memoryGiB = values['memory-gib'] === undefined ? 0 : Number(values['memory-gib'])
  if (!(memoryGiB >= 0)) throw new Error(`--memory-gib takes a number of GiB, got ${String(values['memory-gib'])}`)
  if (positionals.length === 0) throw new Error('give the command after --, such as `-- node_modules/.bin/tsc -p delorun/apps/tools/tsconfig.json --noEmit`')
  const grant = await takeSlots(host.slots, host.paths, host.budget, { want: slots, min: slots, memoryBytes: memoryGiB * GIB, disk: values.disk, priority: gatePriority(host.env, false), label: `with-slots: ${positionals.join(' ').replace(/\s+/g, ' ').slice(0, 160)}`, ...host.cwd === undefined ? {} : { cwd: host.cwd } })
  if (grant.waitedMs >= 1000) host.slots.say(`with-slots: waited ${String(Math.round(grant.waitedMs / 1000))} s for ${String(grant.slots)} slots\n`)
  return host.run(positionals, { ...host.env, DELORUN_SLOTS: String(grant.slots) })
}

/**
 * Run a command with inherited standard streams.
 * @param argv - the command and its arguments.
 * @param env - its environment.
 * @returns the exit status, 1 when it ended by a signal or did not start.
 */
export function runInherited(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command = '', ...args] = argv
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    child.once('error', (error) => {
      process.stderr.write(`with-slots: ${command} did not start: ${error.message}\n`)
      resolve(1)
    })
    child.once('close', code => { resolve(code ?? 1) })
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const budget = cgroupBudget(availableParallelism(), totalmem(), name => readFileSync(join('/sys/fs/cgroup', name), 'utf8'))
  process.exitCode = await withSlots(process.argv.slice(2), {
    slots: nodeSlotHost(line => process.stderr.write(line)),
    paths: privateSlotPaths(tmpdir(), process.getuid?.() ?? -1),
    budget: machineBudget(budget.cpus, runMemoryBytes(budget.memoryBytes), process.env),
    env: process.env,
    cwd: process.cwd(),
    run: runInherited,
  }).catch((error: unknown) => {
    process.stderr.write(`with-slots: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  })
}
