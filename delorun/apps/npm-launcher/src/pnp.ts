/**
 * The launcher under Yarn Plug'n'Play. Yarn starts a package's bin with `--require .pnp.cjs` in `NODE_OPTIONS`, which
 * patches `fs` in place with its own file handles, and some of their methods (`sync()` among them) throw
 * `Method not implemented`. The launcher writes its trust files and the runtime store through exactly those calls, so
 * it must not run inside that patch. It therefore starts one plain Node process on the same entry file, with
 * `NODE_OPTIONS` dropped, and ends with that process's status. The runtime already starts without `NODE_OPTIONS`
 * (`inheritableEnvironment`), so only the launcher needs this.
 *
 * `entry.ts` loads this module only when `process.versions.pnp` is set, so every other launch reads none of it.
 *
 * @module @delorun/npm-launcher/pnp
 */
import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inheritableEnvironment } from '@delorun/contract-home-layout'

/**
 * The variable the re-run sets to the re-running process's id. A process whose parent's id is that value is the re-run,
 * so a process that still sees Plug'n'Play there refuses rather than starts a third. A launcher started deeper (a
 * runtime's tool running `yarn delorun` in a Plug'n'Play project) has another parent and re-runs once for itself.
 */
export const PNP_RERUN_ENV = 'DELORUN_LAUNCHER_PNP_RERUN_FROM'

/**
 * The signals the re-running process passes on to the process it started. SIGINT is not one: the terminal sends Ctrl-C to
 * the whole foreground process group, so the child already has it, and a second one would make its stop abrupt (as in
 * `bin.ts`'s `spawnRuntime`).
 */
export const PNP_FORWARDED_SIGNALS = ['SIGTERM', 'SIGHUP'] as const

/** What the launcher does about Plug'n'Play, decided from the facts of this process. */
export type PnpDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'refuse', readonly line: string }
  | { readonly action: 'rerun' }

/** The facts {@link pnpDecision} reads. */
export interface PnpFacts {
  /** `process.versions.pnp`; set when Yarn's Plug'n'Play runtime is loaded in this process. */
  readonly pnp: string | undefined
  /** The entry file's path as this process sees it. */
  readonly entryFile: string
  /** The marker variable's value, if the environment holds one. */
  readonly marker: string | undefined
  /** `process.ppid`. */
  readonly parentId: number
}

/**
 * The line to print when the launcher cannot leave Plug'n'Play because Yarn kept the package packed in its cache.
 * @param entryFile - the entry file's path.
 * @returns the refusal.
 */
export function packedRefusal(entryFile: string): string {
  return `Delorun cannot start from ${entryFile}: Yarn's Plug'n'Play keeps the package inside a zip file. Set "nodeLinker: node-modules" in .yarnrc.yml, or run "npx delorun" instead.`
}

/**
 * The line to print when the re-run is itself under Plug'n'Play, which must never start a third process.
 * @returns the refusal.
 */
export function loopRefusal(): string {
  return 'Delorun cannot leave Yarn\'s Plug\'n\'Play here. Set "nodeLinker: node-modules" in .yarnrc.yml, or run "npx delorun" instead.'
}

/**
 * Whether a path lies inside a zip file in a Yarn folder, which only a Plug'n'Play runtime can read. A project folder
 * that is itself named `something.zip` is not one: the `.zip` has to come after a `.yarn` folder (the project's cache, or
 * the global one in the home folder).
 * @param path - the entry file's path.
 * @returns `true` for a path through a `.zip` folder below a `.yarn` folder.
 */
export function insideZip(path: string): boolean {
  return /[\\/]\.yarn[\\/](?:.*[\\/])?[^\\/]*\.zip[\\/]/u.test(path)
}

/**
 * Decide what the launcher does about Plug'n'Play.
 * @param facts - what this process reports.
 * @returns `continue` outside Plug'n'Play, `refuse` with the one line to print when it cannot leave (a second re-run,
 *   or a package still in a zip), and `rerun` otherwise.
 */
export function pnpDecision(facts: PnpFacts): PnpDecision {
  if (facts.pnp === undefined) return { action: 'continue' }
  if (facts.marker === String(facts.parentId)) return { action: 'refuse', line: loopRefusal() }
  if (insideZip(facts.entryFile)) return { action: 'refuse', line: packedRefusal(facts.entryFile) }
  return { action: 'rerun' }
}

/** The part of a child process {@link leavePnp} uses. */
export interface PnpChild {
  /** Sends a signal to the child. */
  kill(signal: NodeJS.Signals): boolean
  /** Reports the child's end. */
  once(event: 'close', listener: (status: number | null, signal: NodeJS.Signals | null) => void): unknown
  /** Reports that the child could not start. */
  once(event: 'error', listener: (error: Error) => void): unknown
}

/** Starts a process on the given command with its streams shared and the given environment. */
export type StartPnpChild = (command: string, args: readonly string[], options: { readonly stdio: 'inherit', readonly env: Record<string, string> }) => PnpChild

/** What {@link leavePnp} needs from its surroundings; a spec gives its own. */
export interface PnpSurroundings {
  /** `process.versions.pnp`. */
  readonly pnp: string | undefined
  /** The entry file's `file:` URL, `import.meta.url` of `entry.ts`. */
  readonly entryUrl: string
  /** The arguments after the entry file. */
  readonly argv: readonly string[]
  /** This process's environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** `process.execPath`. */
  readonly execPath: string
  /** `process.pid`. */
  readonly pid: number
  /** `process.ppid`. */
  readonly parentId: number
  /** Starts the process; Node's `spawn` by default. */
  readonly start?: StartPnpChild | undefined
  /** Registers a signal listener; the process's by default. */
  readonly listen?: ((signal: NodeJS.Signals, listener: () => void) => void) | undefined
  /** Removes a signal listener; the process's by default. */
  readonly unlisten?: ((signal: NodeJS.Signals, listener: () => void) => void) | undefined
}

/** How the launcher ends after {@link leavePnp}. */
export type PnpOutcome =
  | { readonly action: 'continue' }
  | { readonly action: 'refuse', readonly line: string }
  | { readonly action: 'exit', readonly code: number }
  | { readonly action: 'signal', readonly signal: NodeJS.Signals }

/**
 * Leave Plug'n'Play: start one plain Node process on the same entry file with the same arguments, and wait for it.
 * While it runs, a SIGTERM or SIGHUP this process receives is passed on to it, and a SIGINT is left to the terminal, which
 * sends it to the child too; this process stays until the child has ended.
 * @param surroundings - this process's facts, and the injected process start for a spec.
 * @returns `continue` when there is no Plug'n'Play; `refuse` with the line to print when the launcher cannot leave it;
 *   `exit` with the child's status; `signal` when a signal ended the child, which the caller raises on itself.
 * @throws {Error} when the child cannot be started.
 */
export function leavePnp(surroundings: PnpSurroundings): Promise<PnpOutcome> {
  const entryFile = fileURLToPath(surroundings.entryUrl)
  const decision = pnpDecision({ pnp: surroundings.pnp, entryFile, marker: surroundings.env[PNP_RERUN_ENV], parentId: surroundings.parentId })
  if (decision.action !== 'rerun') return Promise.resolve(decision)
  const start = surroundings.start ?? ((command, args, options) => spawn(command, [...args], options))
  const listen = surroundings.listen ?? ((signal, listener) => { process.on(signal, listener) })
  const unlisten = surroundings.unlisten ?? ((signal, listener) => { process.off(signal, listener) })
  return new Promise<PnpOutcome>((resolve, reject) => {
    const env = { ...inheritableEnvironment(surroundings.env), [PNP_RERUN_ENV]: String(surroundings.pid) }
    const child = start(surroundings.execPath, [entryFile, ...surroundings.argv], { stdio: 'inherit', env })
    const forwards = PNP_FORWARDED_SIGNALS.map(signal => [signal, () => { child.kill(signal) }] as const)
    for (const [signal, forward] of forwards) listen(signal, forward)
    // Listening for SIGINT replaces Node's default, which would end this process while the child stops.
    const interrupt = (): void => undefined
    listen('SIGINT', interrupt)
    const settle = (): void => {
      for (const [signal, forward] of forwards) unlisten(signal, forward)
      unlisten('SIGINT', interrupt)
    }
    child.once('error', (error) => { settle(); reject(error) })
    child.once('close', (status, signal) => {
      settle()
      if (status !== null) resolve({ action: 'exit', code: status })
      else if (signal !== null) resolve({ action: 'signal', signal })
      else resolve({ action: 'exit', code: 1 })
    })
  })
}

/**
 * The status to exit with for a signal that ended the child, when this process cannot re-raise it.
 * @param signal - the signal.
 * @returns `128` plus its number.
 */
export function signalStatus(signal: NodeJS.Signals): number {
  return 128 + osConstants.signals[signal]
}
