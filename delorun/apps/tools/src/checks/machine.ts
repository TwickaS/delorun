/**
 * The machine a check run gets: a memory ceiling that leaves the rest of the
 * system responsive, the test runners' worker counts inside it, a systemd
 * scope that enforces the ceiling without swap, a scratch directory for the
 * run's temporary files, and an environment confined to the Linux side of
 * WSL.
 *
 * Without a ceiling, a run that outgrows memory swaps; on WSL the swap file
 * lives on the Windows disk, and the whole VM, the terminal and the agent in
 * it included, stalls until the run ends. Inside the scope the kernel instead
 * stops the largest process of the run, the check fails, and the machine
 * stays usable.
 *
 * @module @delorun/tools/checks/machine
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { RUNNER_CONTROL_ENV } from './cache.ts'

const GIB = 1024 ** 3

/**
 * The share of the machine kept outside the runs, for the desktop, editors and agents. A fraction rather than a fixed
 * floor, so the headroom follows the machine it is measured on: an eighth of 23 GiB is 2.9 GiB, where a 2 GiB floor was
 * a guess made for a 21 GB machine and would leave a small machine with nothing to run in.
 */
const HEADROOM_FRACTION = 1 / 8
/** The least headroom, so a machine of a few GiB still keeps something for the work beside the runs. */
const MIN_HEADROOM_BYTES = GIB
/** The least a run may be budgeted, so a machine whose headroom leaves less still runs one check. */
const MIN_RUN_BYTES = GIB

/**
 * Memory kept outside the run, for the desktop, editors and agents: an eighth of the machine, and at least 1 GiB.
 * @param memoryBytes - the machine's or the cgroup's memory.
 * @returns the bytes to leave free.
 */
export function headroomBytes(memoryBytes: number): number {
  return Math.max(MIN_HEADROOM_BYTES, Math.floor(memoryBytes * HEADROOM_FRACTION))
}

/**
 * The run's memory ceiling.
 * @param memoryBytes - the machine's memory.
 * @returns the memory less {@link headroomBytes}, and at least 1 GiB.
 */
export function runMemoryBytes(memoryBytes: number): number {
  return Math.max(MIN_RUN_BYTES, memoryBytes - headroomBytes(memoryBytes))
}

/** Memory a fork-suite worker holds at its peak: the whole fork suite peaked at 6.4 GiB with 17 workers. */
const FORK_WORKER_BYTES = 0.5 * GIB
/** Memory an upstream-suite worker holds at its peak, measured at about 0.7 GiB at 12 workers. */
const UPSTREAM_WORKER_BYTES = GIB
/** Memory kept for the compilers and generators that run beside the fork suite. */
const COMPILERS_BYTES = 3 * GIB

/** The test runners' worker counts. */
export interface Workers {
  /** The fork suite's workers. */
  readonly fork: number
  /** The changed-upstream lane's workers, before its own cap of eight. */
  readonly upstream: number
}

/**
 * The test runners' worker counts inside the run's ceiling. The fork suite
 * gets the CPUs less two for the compilers, and the memory left after
 * {@link COMPILERS_BYTES}.
 * @param cpus - the CPU count.
 * @param memoryBytes - the run's memory ceiling.
 * @returns at least one worker each.
 */
export function workerCounts(cpus: number, memoryBytes: number): Workers {
  return {
    fork: Math.max(1, Math.min(cpus - 2, Math.floor((memoryBytes - COMPILERS_BYTES) / FORK_WORKER_BYTES))),
    upstream: Math.max(1, Math.min(cpus - 1, Math.floor(memoryBytes / UPSTREAM_WORKER_BYTES))),
  }
}

/**
 * Whether this process can start a systemd user scope, which enforces the ceiling.
 * @returns false without a user manager, as on WSL without `systemd=true` or in a container.
 */
export function canScope(): boolean {
  try {
    execFileSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch (error) {
    // No systemd-run, no user manager, or no delegated controllers: the run goes ahead without a ceiling.
    if (error instanceof Error) return false
    throw error
  }
}

/**
 * The command that runs `argv` in a systemd user scope with the ceiling, no swap and a lower CPU and IO weight, so other work stays responsive while the run uses idle CPUs.
 * @param argv - the command.
 * @param memoryBytes - the ceiling.
 * @returns the `systemd-run` command line.
 */
export function scopeCommand(argv: readonly string[], memoryBytes: number): string[] {
  return ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${String(memoryBytes)}`, '-p', 'MemorySwapMax=0', '-p', 'CPUWeight=50', '-p', 'IOWeight=50', '--description=delorun checks', '--', ...argv]
}

/** The memory controller files of the cgroup this process runs in, when cgroup v2 exposes them. */
function cgroupDir(): string | undefined {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(entry => entry.startsWith('0::'))
    return line === undefined ? undefined : join('/sys/fs/cgroup', line.slice(3))
  } catch (error) {
    // Not Linux, or no cgroup v2: nothing to report.
    if (error instanceof Error) return undefined
    throw error
  }
}

/** What the scope recorded about the run's memory. */
export interface MemoryReport {
  /** The highest memory the run held, when the kernel records it. */
  readonly peakBytes?: number
  /** Processes the kernel stopped for exceeding the ceiling. */
  readonly oomKills: number
}

/**
 * Read this run's peak memory and out-of-memory kills from its cgroup.
 * @returns the report, or undefined outside a cgroup v2 scope.
 */
export function memoryReport(): MemoryReport | undefined {
  const dir = cgroupDir()
  if (dir === undefined) return undefined
  try {
    const events = readFileSync(join(dir, 'memory.events'), 'utf8')
    const oomKills = Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0)
    let peakBytes: number | undefined
    try {
      peakBytes = Number(readFileSync(join(dir, 'memory.peak'), 'utf8').trim())
    } catch (error) {
      // Kernels before 5.19 keep no peak.
      if (!(error instanceof Error)) throw error
    }
    return peakBytes === undefined ? { oomKills } : { peakBytes, oomKills }
  } catch (error) {
    // The cgroup has no memory controller.
    if (error instanceof Error) return undefined
    throw error
  }
}

/** The variable that chooses where a run's temporary files go: `disk` (the default) or `memory`. */
export const SCRATCH_ENV = 'DELORUN_CHECKS_SCRATCH'
/** The variable that sets the memory a run's temporary files may take on a memory file system, in GiB. */
export const SCRATCH_CAP_ENV = 'DELORUN_CHECKS_SCRATCH_GIB'
/** The memory a run's temporary files may take on a memory file system when the environment names no other figure. */
const DEFAULT_SCRATCH_GIB = 4
/** `statfs`'s type of a tmpfs. */
const TMPFS_MAGIC = 0x01021994

/** Where a run's temporary files go. */
export interface ScratchPlace {
  /** The directory the run's scratch directory is made in. */
  readonly base: string
  /** Whether it is a memory file system. */
  readonly memory: boolean
  /** The memory set aside for the files on a memory file system, which the run's budget gives up; 0 on disk. */
  readonly capBytes: number
  /** Why a run that asked for memory got the disk. */
  readonly fallback?: string
}

/** What {@link scratchPlace} reads from the machine. */
export interface ScratchProbe {
  /** The system's temporary directory. */
  readonly tmpdir: string
  /**
   * A directory's file system: its `statfs` type and the bytes free to this user, or undefined when it does not exist.
   * @param dir - the directory.
   * @returns the facts.
   */
  readonly statfs: (dir: string) => { readonly type: number, readonly freeBytes: number } | undefined
}

/**
 * Where a run's temporary files go: the system's temporary directory, or with `DELORUN_CHECKS_SCRATCH=memory` a memory file
 * system (`/dev/shm`, else `$XDG_RUNTIME_DIR`) that has `DELORUN_CHECKS_SCRATCH_GIB` (default 4) free, which the run's memory
 * budget then gives up. A request for memory that no memory file system can meet falls back to the disk and says why.
 * @param env - the environment.
 * @param probe - the machine.
 * @returns the place.
 * @throws Error when the variable names neither `disk` nor `memory`, or the figure is not a positive number.
 */
export function scratchPlace(env: NodeJS.ProcessEnv, probe: ScratchProbe): ScratchPlace {
  const choice = env[SCRATCH_ENV] ?? 'disk'
  if (choice !== 'disk' && choice !== 'memory') throw new Error(`${SCRATCH_ENV} takes disk or memory, got ${choice}`)
  const disk = { base: probe.tmpdir, memory: false, capBytes: 0 }
  if (choice === 'disk') return disk
  const gib = env[SCRATCH_CAP_ENV] === undefined ? DEFAULT_SCRATCH_GIB : Number(env[SCRATCH_CAP_ENV])
  if (!(gib > 0)) throw new Error(`${SCRATCH_CAP_ENV} takes a positive number of GiB, got ${String(env[SCRATCH_CAP_ENV])}`)
  const capBytes = Math.round(gib * GIB)
  const candidates = ['/dev/shm', env['XDG_RUNTIME_DIR']].filter((dir): dir is string => dir !== undefined && dir !== '')
  for (const dir of candidates) {
    const facts = probe.statfs(dir)
    if (facts?.type === TMPFS_MAGIC && facts.freeBytes >= capBytes) return { base: dir, memory: true, capBytes }
  }
  return { ...disk, fallback: `no memory file system (${candidates.join(', ')}) has ${String(gib)} GiB free` }
}

/**
 * The file system facts {@link scratchPlace} reads, from `statfs`.
 * @param dir - the directory.
 * @returns its type and free bytes, or undefined when it does not exist.
 */
export function statfsOf(dir: string): { readonly type: number, readonly freeBytes: number } | undefined {
  try {
    const stats = statfsSync(dir)
    return { type: stats.type, freeBytes: stats.bavail * stats.bsize }
  } catch (error) {
    // ENOENT: no such directory on this machine.
    void error
    return undefined
  }
}

/**
 * A scratch directory for the run's temporary files.
 * @param base - the directory to make it in, from {@link scratchPlace}; the system's temporary directory by default.
 * @returns the new directory.
 */
export function scratchDir(base: string = tmpdir()): string {
  return mkdtempSync(join(base, 'delorun-checks-'))
}

/**
 * Remove a run's scratch directory, which a check may have left with directories it made unreadable or unwritable, such as
 * a spec of a permission refusal that was interrupted. Each directory is made the owner's again before the removal; a
 * removal that still fails is reported and does not end the run, whose results are already known.
 * @param dir - the scratch directory.
 * @returns undefined, or why the directory is left behind.
 */
export function removeScratch(dir: string): string | undefined {
  const own = (path: string): void => {
    if (!lstatSync(path).isDirectory()) return
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) own(join(path, name))
  }
  try {
    own(dir)
    rmSync(dir, { recursive: true, force: true })
    return undefined
  } catch (error) {
    // EACCES or EPERM on a path the run's user cannot take back, or ENOENT when another process removed it first.
    return String(error)
  }
}

/**
 * Variables that lead a WSL process to the Windows side: the ones WSL-aware
 * code reads before it calls Windows programs (`wslpath`, `explorer.exe`,
 * `powershell.exe`), WSLg's display and sound servers, which run on Windows,
 * and `NoDefaultCurrentDirectoryInExePath`, a Windows setting the Windows
 * side passes into WSL shells.
 */
const WINDOWS_SIDE = ['WSL_DISTRO_NAME', 'WSL_INTEROP', 'WSLENV', 'WSL2_GUI_APPS_ENABLED', 'DISPLAY', 'WAYLAND_DISPLAY', 'PULSE_SERVER', 'NoDefaultCurrentDirectoryInExePath']

/**
 * Keep check processes on the Linux side of WSL: drop the Windows directories
 * WSL appends to `PATH`, where each command lookup reads the Windows disk,
 * and the {@link WINDOWS_SIDE} variables. Outside WSL nothing changes.
 * @param env - the environment the checks inherit, changed in place.
 */
function confineToLinux(env: NodeJS.ProcessEnv): void {
  if (env['WSL_DISTRO_NAME'] === undefined && env['WSL_INTEROP'] === undefined) return
  env['PATH'] = (env['PATH'] ?? '').split(':').filter(entry => !entry.startsWith('/mnt/')).join(':')
  for (const name of WINDOWS_SIDE) delete env[name]
}

/**
 * The environment every check inherits: this process's, without git's
 * repository variables and without the invoking shell's `NODE_ENV`, confined
 * to the Linux side of WSL, with the run's scratch directory as the temporary
 * directory and without colour. Git exports `GIT_DIR`, `GIT_INDEX_FILE` and
 * others to a hook's processes; a test that runs git in a fixture repository
 * would otherwise act on this repository instead, as a pre-push run once did
 * when upstream fixtures set `core.bare` and `user.name` in its config. An
 * inherited `NODE_ENV` would decide how CommonJS dependencies resolve in the
 * test lanes: React's entry then loads its production build, whose `act`
 * throws under @testing-library/react. Unset, vitest defaults it to `test`,
 * the value upstream's CI specs run under; build tools keep their own
 * production defaults. The variables that steer the runner ({@link RUNNER_CONTROL_ENV}) are removed too: a check's
 * result must not depend on the tier or priority of the run that started it, since the pass cache does not key them.
 * @param env - the environment to start from.
 * @param scratch - the run's scratch directory.
 * @returns a new environment.
 */
export function checkEnvironment(env: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_') && name !== 'NODE_ENV' && !RUNNER_CONTROL_ENV.includes(name)))
  confineToLinux(clean)
  return { ...clean, TMPDIR: scratch, TMP: scratch, TEMP: scratch, NO_COLOR: '1', FORCE_COLOR: '0' }
}

/**
 * The answer of the script `pnpm exec` ran to read the environment it gives
 * scripts. pnpm writes its own warnings to stdout before the script runs,
 * such as one for an optional package of another platform when it checks
 * the dependencies, so the answer is the last line.
 * @param stdout - what `pnpm exec` printed.
 * @returns `npm_execpath` and `pnpm_config_verify_deps_before_run`.
 * @throws Error when the last line is not the answer.
 */
export function pnpmExecAnswer(stdout: string): { readonly execpath: string, readonly verify: string } {
  const last = stdout.trimEnd().split('\n').at(-1) ?? ''
  let json: unknown
  try {
    json = JSON.parse(last)
  } catch (error) {
    throw new Error(`pnpm exec printed no answer on its last line: ${last.slice(0, 200)}`, { cause: error })
  }
  const parsed = z.tuple([z.string(), z.string()]).safeParse(json)
  if (!parsed.success) throw new Error(`pnpm exec answered something else: ${last.slice(0, 200)}`)
  const [execpath, verify] = parsed.data
  if (execpath === '') throw new Error('pnpm exec gave no npm_execpath; is the repository\'s pnpm installed?')
  return { execpath, verify }
}

/**
 * The CPUs and memory this process may use: the machine's, lowered to its cgroup's limits inside a container, whose `nproc` and `free` report the host.
 * @param cpus - the machine's CPU count.
 * @param memoryBytes - the machine's memory.
 * @param read - reads a cgroup file, or throws when there is none.
 * @returns the effective CPU count and memory.
 */
export function cgroupBudget(cpus: number, memoryBytes: number, read: (name: string) => string): { readonly cpus: number, readonly memoryBytes: number } {
  let effectiveCpus = cpus
  let effectiveMemory = memoryBytes
  try {
    const [quota = 'max', period = '100000'] = read('cpu.max').trim().split(' ')
    if (quota !== 'max') effectiveCpus = Math.max(1, Math.min(cpus, Math.floor(Number(quota) / Number(period))))
  } catch (error) {
    // No cgroup v2 CPU limit: the machine's count stands.
    void error
  }
  try {
    const limit = read('memory.max').trim()
    if (limit !== 'max') effectiveMemory = Math.min(memoryBytes, Number(limit))
  } catch (error) {
    // No cgroup v2 memory limit: the machine's memory stands.
    void error
  }
  return { cpus: effectiveCpus, memoryBytes: effectiveMemory }
}

/**
 * The share of the last ten seconds in which some task waited for the disk (`/proc/pressure/io`, `some avg10`).
 * @param read - reads a file, or throws when there is none.
 * @returns the percentage, or undefined where the kernel reports no pressure.
 */
export function ioPressure(read: (path: string) => string): number | undefined {
  try {
    const avg10 = /^some avg10=([\d.]+)/m.exec(read('/proc/pressure/io'))?.[1]
    return avg10 === undefined ? undefined : Number(avg10)
  } catch (error) {
    // ENOENT: not Linux, or a kernel without pressure stall information.
    void error
    return undefined
  }
}

/** The resources whose pressure the alarm reads, each from its own file under `/proc/pressure`. */
export const PRESSURE_RESOURCES = ['cpu', 'memory', 'io'] as const

/** A resource whose pressure the alarm reads. */
export type PressureResource = typeof PRESSURE_RESOURCES[number]

/** The windows the kernel averages pressure over, in seconds. */
export const PRESSURE_WINDOWS = [10, 60, 300] as const

/** A window the kernel averages pressure over, in seconds. */
export type PressureWindow = typeof PRESSURE_WINDOWS[number]

/** One resource's pressure, as `/proc/pressure/<resource>` reports it. */
export interface PressureReading {
  /** The share of the window in which some task stalled, as a percentage. */
  readonly some: number
  /** The share of the window in which every task stalled, as a percentage; 0 where the kernel reports none. */
  readonly full: number
}

/** The machine's pressure, by resource and window. */
export type Pressure = Readonly<Record<PressureResource, Readonly<Record<PressureWindow, PressureReading>>>>

/**
 * The pressure a `/proc/pressure/<resource>` file reports, for each window it names.
 * @param text - the file's text.
 * @returns the readings by window, or undefined when the text names no window.
 */
export function parsePressure(text: string): Readonly<Record<PressureWindow, PressureReading>> | undefined {
  // Each line is one kind of stall, `some` or `full`, followed by a reading for every window: `some avg10=0.66 avg60=1.29
  // avg300=3.55 total=...`. The kind is named once, so the windows are read from the line it heads.
  const line = (kind: 'some' | 'full'): Map<number, number> => {
    const found = new Map<number, number>()
    for (const entry of text.split('\n')) {
      if (!entry.startsWith(kind)) continue
      for (const [, window, value] of entry.matchAll(/avg(\d+)=([\d.]+)/g)) found.set(Number(window), Number(value))
    }
    return found
  }
  const some = line('some')
  const full = line('full')
  const readings: Partial<Record<PressureWindow, PressureReading>> = {}
  for (const window of PRESSURE_WINDOWS) {
    const stalled = some.get(window)
    if (stalled === undefined) continue
    readings[window] = { some: stalled, full: full.get(window) ?? 0 }
  }
  const [ten, sixty, threeHundred] = PRESSURE_WINDOWS.map(window => readings[window])
  return ten === undefined || sixty === undefined || threeHundred === undefined ? undefined : { 10: ten, 60: sixty, 300: threeHundred }
}

/**
 * The machine's pressure on every resource the alarm reads. A resource the kernel does not report is left out, so a
 * machine without pressure stall information yields no pressure at all rather than a false calm.
 * @param read - reads a file, or throws when there is none.
 * @returns the pressure, or undefined where the kernel reports none.
 */
export function readPressure(read: (path: string) => string): Pressure | undefined {
  const readOne = (resource: PressureResource): Readonly<Record<PressureWindow, PressureReading>> | undefined => {
    try {
      return parsePressure(read(`/proc/pressure/${resource}`))
    } catch (error) {
      // ENOENT: not Linux, or a kernel without pressure stall information.
      void error
      return undefined
    }
  }
  const [cpu, memory, io] = PRESSURE_RESOURCES.map(readOne)
  return cpu === undefined || memory === undefined || io === undefined ? undefined : { cpu, memory, io }
}

/**
 * The share of the window in which some task stalled on a resource, which is the figure the alarm reads: `some` counts a
 * machine that is still serving other work, where `full` counts only one where nothing ran at all.
 * @param pressure - the machine's pressure.
 * @param resource - the resource.
 * @param window - the window, in seconds.
 * @returns the percentage, or undefined when the kernel reports no such reading.
 */
export function pressureOf(pressure: Pressure | undefined, resource: PressureResource, window: PressureWindow): number | undefined {
  return pressure?.[resource]?.[window].some
}

/**
 * The threshold above which a resource counts as overloaded, as a percentage of the window. The figures are far above the
 * baseline this machine runs at (cpu `some avg300` 12%, memory `full avg300` 0.11%, io `some avg300` 0.27%), so ordinary
 * work never reaches them: cpu at 50% of a five-minute window means half the machine's time was spent waiting for a CPU,
 * memory at 10% means the kernel was reclaiming for a tenth of it, and io at 50% means the disk was the limit throughout.
 */
export const OVERLOAD_PERCENT: Readonly<Record<PressureResource, number>> = { cpu: 50, memory: 10, io: 50 }

/** The window the alarm averages over: five minutes, so a spike of a few seconds never trips it. */
export const ALARM_WINDOW: PressureWindow = 300

/** Why the alarm is on, or undefined when the machine is not overloaded. */
export interface Overload {
  /** The resources over their threshold, with the share of the window each stalled for. */
  readonly resources: readonly { readonly resource: PressureResource, readonly percent: number, readonly threshold: number }[]
  /** The window the figures are averaged over, in seconds. */
  readonly window: PressureWindow
}

/**
 * Whether the machine has been overloaded for the alarm's window, and on what. A resource the kernel does not report is
 * not overloaded: the alarm holds new grants only on evidence, never on a missing reading.
 * @param pressure - the machine's pressure, or undefined where the kernel reports none.
 * @param thresholds - the threshold of each resource, as a percentage; {@link OVERLOAD_PERCENT} by default.
 * @param window - the window to average over; {@link ALARM_WINDOW} by default.
 * @returns the overload, or undefined when no resource is over its threshold.
 */
export function overloadOf(pressure: Pressure | undefined, thresholds: Readonly<Record<PressureResource, number>> = OVERLOAD_PERCENT, window: PressureWindow = ALARM_WINDOW): Overload | undefined {
  const resources = PRESSURE_RESOURCES.flatMap((resource) => {
    const percent = pressureOf(pressure, resource, window)
    return percent === undefined || percent < thresholds[resource] ? [] : [{ resource, percent, threshold: thresholds[resource] }]
  })
  return resources.length === 0 ? undefined : { resources, window }
}

/**
 * The line that says why the alarm holds new grants, for a wait report and `--queue`.
 * @param overload - the overload.
 * @returns such as `the machine is overloaded: cpu 61.2% of the last 300 s (over 50%)`.
 */
export function describeOverload(overload: Overload): string {
  const parts = overload.resources.map(({ resource, percent, threshold }) => `${resource} ${percent.toFixed(1)}% of the last ${String(overload.window)} s (over ${String(threshold)}%)`)
  return `the machine is overloaded: ${parts.join(', ')}`
}
