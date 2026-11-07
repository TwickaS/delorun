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
 * @module @delo/tools/checks/machine
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const GIB = 1024 ** 3

/**
 * Memory kept outside the run, for the desktop, editors and agents: at least 2 GiB and an eighth of the machine.
 * @param memoryBytes - the machine's or the cgroup's memory.
 * @returns the bytes to leave free.
 */
export function headroomBytes(memoryBytes: number): number {
  return Math.max(2 * GIB, Math.floor(memoryBytes / 8))
}

/**
 * The run's memory ceiling.
 * @param memoryBytes - the machine's memory.
 * @returns the memory less {@link headroomBytes}, and at least 2 GiB.
 */
export function runMemoryBytes(memoryBytes: number): number {
  return Math.max(2 * GIB, memoryBytes - headroomBytes(memoryBytes))
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
  return ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${String(memoryBytes)}`, '-p', 'MemorySwapMax=0', '-p', 'CPUWeight=50', '-p', 'IOWeight=50', '--description=delo checks', '--', ...argv]
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

/**
 * A scratch directory for the run's temporary files, under the system's temporary directory.
 * @returns the new directory.
 */
export function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'delo-checks-'))
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
 * production defaults.
 * @param env - the environment to start from.
 * @param scratch - the run's scratch directory.
 * @returns a new environment.
 */
export function checkEnvironment(env: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_') && name !== 'NODE_ENV'))
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
