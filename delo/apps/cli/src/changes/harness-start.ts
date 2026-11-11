/**
 * Where a start runs from when the person changed the harness itself (contract C21, "Harness edits"). The signed
 * installation under `runtimes/<version>/` is never edited; a runtime whose harness record has approved files runs the
 * composed tree `changes/harness/<version>/run/<digest>/` instead ([`@delo/changes`](../../../../packages/changes/src/harness-tree.ts)).
 *
 * Only the signed code decides that: `delorun start --foreground` running from the store's installation, not from a
 * composed tree, whose runtime has approved harness files hands off as its first act, before any lock or token
 * ({@link handOffToComposedTree}). It checks the installation with the runtime store's start check under the root the
 * launcher anchors, builds or checks the composed tree, and runs the tree's `delorun` with the same arguments as a child
 * with this terminal, descriptor 3 passed on when it is open (an update's successor handover), `SIGTERM` and `SIGHUP`
 * forwarded, and the child's exit code returned. A child that exits with a failure before its start ran, as one whose
 * changed file throws when Node imports it does, is reported apart, so the start can leave the change out
 * ([retry](./retry.ts)). A profile in safe mode runs the signed installation. {@link startEntry} is the one function that
 * says which installation's entry a start runs: the hand-off's, the background start's and the retry's after a start
 * left a change out, which always start the signed entry, so the signed code composes again.
 *
 * @module @delo/cli/changes/harness-start
 */
import { spawn, type StdioOptions } from 'node:child_process'
import { existsSync, fstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { applyUnreviewedHarnessChanges, checkComposedTree, composition, isChangesError, prepareComposedTree, retainHarness, type HarnessContext, type SignedRuntime } from '@delo/changes'
import { DELO_HOME_ENTRIES, type RuntimeVersion } from '@delo/contract-home-layout'
import { HANDOVER_FD } from '@delo/contract-home-process'
import { runDirectory } from '@delo/home'
import type { DeloLogger } from '@delo/logs'
import { readSafeMode } from '@delo/profile-safety'
import { parseRuntimeVersion, RuntimeStoreError, StorePaths, type TrustedRootSource } from '@delo/runtime-store'
import type { CommandOutput, CommandResult } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { otherDataUsers } from '../home-exclusion.ts'
import { closureRootOf } from '../package-manager.ts'
import { printable } from '../terminal-text.ts'
import { runtimePlatformOf } from '../update/channel.ts'
import type { RunningRuntime } from '../update/runtime.ts'
import { signedRuntimeOf } from '../update/signed-runtime.ts'
import { checkStoredRuntime } from '../update/store-support.ts'
import { launcherAnchor } from '../update/trusted-root.ts'

/** The Node executable and the `delorun` entry file a process runs. */
export interface EntryCommand {
  /** The Node executable. */
  readonly node: string
  /** The `delorun` entry file. */
  readonly entry: string
}

/** What a composed tree's root path is, below the Delo home: `changes/harness/<version>/run/<digest>`. */
const COMPOSED_ROOT = /^(?<version>[^/\\]+)[/\\]run[/\\][0-9a-f]{64}$/u

/**
 * The signed installation a composed tree was built from.
 * @param root - a runtime closure's root.
 * @returns `<home>/runtimes/<version>` when the root is a composed tree `<home>/changes/harness/<version>/run/<digest>`;
 *   otherwise undefined.
 */
export function signedRootOf(root: string): string | undefined {
  const harness = dirname(dirname(dirname(root)))
  if (basename(harness) !== 'harness' || basename(dirname(harness)) !== DELO_HOME_ENTRIES.changes) return undefined
  const match = COMPOSED_ROOT.exec(relative(harness, root))
  const version = match?.groups?.version
  if (version === undefined || parseRuntimeVersion(version) === undefined) return undefined
  return join(dirname(dirname(harness)), DELO_HOME_ENTRIES.runtimes, version)
}

/**
 * Which installation's `delorun` a start runs: the signed installation's, or with `tree`, the composed tree's. A
 * process that runs from a composed tree maps to the signed installation it was built from; one that does not run from
 * a runtime closure, as a source checkout does, runs itself.
 * @param running - this process's Node executable and entry file.
 * @param tree - a composed tree of the same installation, to run instead.
 * @returns the Node executable and entry file to start.
 */
export function startEntry(running: EntryCommand, tree?: string): EntryCommand {
  const root = closureRootOf(running.entry)
  if (root === undefined) return running
  const target = tree ?? signedRootOf(root) ?? root
  const node = running.node.startsWith(`${root}${sep}`) ? join(target, relative(root, running.node)) : running.node
  return { node, entry: join(target, relative(root, running.entry)) }
}

/**
 * The runtime store's start check of an installed version under the root the launcher anchors, as the signed file
 * list of {@link SignedRuntime}.
 * @param home - the Delo home.
 * @param version - the installed version.
 * @param env - the environment `delorun` was started with, read for the launcher's roots.
 * @param logger - receives the store's warnings.
 * @returns the installation and its verified file list.
 * @throws {RuntimeStoreError} when the version's files do not match its signed file list or the root is not anchored.
 */
export async function verifiedSignedRuntime(home: string, version: RuntimeVersion, env: Readonly<Record<string, string | undefined>>, logger: DeloLogger): Promise<SignedRuntime> {
  return signedRuntimeOf(installationOf(home, version), await checkStoredRuntime(home, version, logger, launcherAnchor(home, env).root))
}

/**
 * The harness `delorun changes` works on: the running runtime's, when it runs from the store. Its signed installation
 * is checked once, the first time an action needs it.
 * @param home - the Delo home.
 * @param runtime - the runtime this process runs.
 * @param env - the environment `delorun` was started with.
 * @param logger - receives the store's warnings.
 * @param signed - how the signed installation is read; {@link verifiedSignedRuntime} by default.
 * @returns the context, or undefined outside the runtime store.
 */
export function harnessContextOf(home: string, runtime: RunningRuntime, env: Readonly<Record<string, string | undefined>>, logger: DeloLogger, signed: typeof verifiedSignedRuntime = verifiedSignedRuntime): HarnessContext | undefined {
  if (!runtime.store) return undefined
  let read: Promise<SignedRuntime> | undefined
  return { home, runtime: runtime.version, signed: () => (read ??= signed(home, runtime.version, env, logger)) }
}

/** The signals a process that waits for a child passes on to it. */
const FORWARDED = ['SIGTERM', 'SIGHUP'] as const

/** How a child process ended. */
export interface ChildExit {
  /** Its exit code, or null when a signal ended it. */
  readonly code: number | null
}

/**
 * Run `delorun` in a child process with this terminal and wait for it: `SIGTERM` and `SIGHUP` are passed on, and an
 * interrupt, which the terminal sends to both, is left to the child. The child stays in this process's process group, so
 * stopping the group, as an update stops a successor that did not become healthy, stops it too.
 * @param command - the Node executable, its options and the arguments.
 * @param env - the child's environment.
 * @param stdio - the child's descriptors.
 * @param failed - what the refusal says when the child cannot be started.
 * @returns how the child ended.
 * @throws {CliError} when the child cannot be started.
 */
export function waitForChild(command: { readonly node: string, readonly args: readonly string[] }, env: Readonly<Record<string, string | undefined>>, stdio: StdioOptions, failed: string): Promise<ChildExit> {
  const child = spawn(command.node, [...command.args], { stdio, env })
  const forwards = FORWARDED.map(signal => [signal, (): void => { child.kill(signal) }] as const)
  const interrupt = (): void => {}
  for (const [signal, forward] of forwards) process.on(signal, forward)
  process.on('SIGINT', interrupt)
  return new Promise<ChildExit>((resolve, reject) => {
    const release = (): void => {
      for (const [signal, forward] of forwards) process.off(signal, forward)
      process.off('SIGINT', interrupt)
    }
    child.once('error', (error) => {
      // A child that could not be started may still report `exit`, which must not set this process's exit code.
      child.removeAllListeners('exit')
      release()
      reject(new CliError(EXIT.failed, `${failed}: ${error.message}`))
    })
    child.once('exit', (code) => {
      release()
      resolve({ code })
    })
  })
}

/**
 * Run `delorun` in a child process with this terminal, as {@link waitForChild} does, and end with its exit code.
 * @param command - the Node executable, its options and the arguments.
 * @param env - the child's environment.
 * @param stdio - the child's descriptors.
 * @param failed - what the refusal says when the child cannot be started.
 * @returns `undefined`, with this process's exit code set to the child's, or to {@link EXIT.failed} when a signal ended
 *   it.
 * @throws {CliError} when the child cannot be started.
 */
export async function runChild(command: { readonly node: string, readonly args: readonly string[] }, env: Readonly<Record<string, string | undefined>>, stdio: StdioOptions, failed: string): Promise<CommandResult> {
  process.exitCode = (await waitForChild(command, env, stdio, failed)).code ?? EXIT.failed
  return undefined
}

/**
 * Whether a descriptor is open.
 * @param fd - the descriptor.
 * @returns whether it is.
 */
export function isOpen(fd: number): boolean {
  try {
    fstatSync(fd)
    return true
  } catch (_closed) {
    // EBADF: nothing is open on the descriptor.
    return false
  }
}

/** A foreground start that may hand off to a composed tree. */
export interface HandOffRequest {
  /** The Delo home. */
  readonly home: string
  /** The CLI profile, whose safe mode runs the signed installation. */
  readonly profile: string
  /** The environment `delorun` was started with, which the child gets. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Where a retention failure is reported. */
  readonly output: CommandOutput
}

/** What a hand-off reads and starts; specs replace each. */
export interface HandOffDependencies {
  /** The runtime this process runs. */
  readonly runtime: RunningRuntime
  /** This process's Node executable and entry file. */
  readonly running: EntryCommand
  /** The arguments this process got after its entry file. */
  readonly args: readonly string[]
  /** The signed installation's check; {@link verifiedSignedRuntime} in a real start. */
  readonly signed: (home: string, version: RuntimeVersion, env: Readonly<Record<string, string | undefined>>) => Promise<SignedRuntime>
  /** Runs the composed tree's `delorun`; {@link waitForChild} in a real start. */
  readonly run: typeof waitForChild
  /** Whether descriptor 3 is open, as an update's successor inherits it. */
  readonly handover: () => boolean
  /** Whether a home process of any profile runs, which may run from another composed tree of the runtime. */
  readonly homeProcessRuns: (home: string) => boolean
}

/**
 * This process's hand-off dependencies.
 * @param runtime - the runtime this process runs.
 * @param output - receives the store's warnings, before the start has a log.
 * @returns them.
 */
export function processHandOff(runtime: RunningRuntime, output: CommandOutput): HandOffDependencies {
  const logger = outputLogger(output)
  return {
    runtime,
    running: { node: process.execPath, entry: String(process.argv[1]) },
    args: process.argv.slice(2),
    signed: (home, version, env) => verifiedSignedRuntime(home, version, env, logger),
    run: waitForChild,
    handover: () => isOpen(HANDOVER_FD),
    homeProcessRuns: home => otherDataUsers(home).some(user => user.profile !== undefined),
  }
}

/**
 * The installed runtime versions of a home's store; the home tree a start prepared holds `runtimes/`.
 * @param home - the Delo home.
 * @returns the names of `runtimes/` that are runtime versions.
 */
function installedRuntimes(home: string): Set<string> {
  return new Set(readdirSync(join(home, DELO_HOME_ENTRIES.runtimes), { withFileTypes: true }).filter(entry => entry.isDirectory() && parseRuntimeVersion(entry.name) !== undefined).map(entry => entry.name))
}

/**
 * A logger for the runtime store whose warnings and errors go to standard error, for a command or a start that has no
 * log of its own yet.
 * @param output - receives the lines.
 * @returns the logger.
 */
export function outputLogger(output: Pick<CommandOutput, 'stderr'>): DeloLogger {
  const write = (message: string): void => { output.stderr(`${message}\n`) }
  return { error: write, warn: write, info: ignore, debug: ignore }
}

/** A logger's method for the levels nobody reads. */
function ignore(): void {}

/**
 * Standard output and error that print nothing, for a report whose store warnings are not shown.
 * @returns the output.
 */
export function quietOutput(): CommandOutput {
  return { stdout: ignore, stderr: ignore }
}

/**
 * Whether a start of `delorun` for a profile from this runtime hands off to a composed tree: it runs the signed
 * installation from the store, the profile is not in safe mode, and the runtime's harness has approved files.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param runtime - the runtime the start runs.
 * @returns whether it does.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the harness's record or log is not one Delo wrote.
 * @throws {ProfileSafetyError} `SAFE_MODE_UNREADABLE` when the profile's safe-mode marker is not one Delo wrote.
 */
export async function handsOff(home: string, profile: string, runtime: RunningRuntime): Promise<boolean> {
  return runtime.store && runtime.composed === undefined && readSafeMode(home, profile) === undefined && await composition(home, runtime.version) !== undefined
}

/**
 * The file a hand-off writes in the profile's run directory before it starts the composed tree's `delorun`, and which
 * that child's start removes as its first act; a file still there after the child exited means its start never ran.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param parent - the process id of the process that hands off.
 * @returns `<home>/run/<profile>/hand-off-<parent>`.
 */
export function handOffMarker(home: string, profile: string, parent: number): string {
  return join(runDirectory(home, profile), `hand-off-${String(parent)}`)
}

/**
 * Print what a start applied without review from the harness's writable copy, and why it applied nothing when the copy
 * could not be read.
 * @param result - what `applyUnreviewedHarnessChanges` did.
 * @param runtime - the running runtime version.
 * @param output - the start's output.
 */
function unreviewedNotice(result: Awaited<ReturnType<typeof applyUnreviewedHarnessChanges>>, runtime: RuntimeVersion, output: CommandOutput): void {
  for (const entry of result.applied) output.stdout(`${printable(`Delo itself (${String(entry.subject.file)}) changed without review, because protection is off: delorun changes show ${entry.id}`)}\n`)
  if (result.unread !== undefined) output.stderr(`${printable(`Delo could not read your copy of Delo ${runtime}, so it runs what it ran: ${result.unread}`)}\n`)
}

/** What a hand-off did. */
export type HandOff =
  /** The composed tree's start ran, or ended by a signal or for an update's successor; `ran` is this start's result. */
  | { readonly kind: 'ran', readonly ran: CommandResult }
  /**
   * The composed tree's `delorun` exited with a failure `code` before its start ran, and this process was not an
   * update's successor; nothing set this process's exit code.
   */
  | { readonly kind: 'not-started', readonly runtime: RuntimeVersion, readonly code: number }

/**
 * Hand a foreground start off to the composed tree of its runtime, when the signed installation runs, the profile is not
 * in safe mode and its runtime has approved harness files. Nothing else runs first: no lock, no token and no log. A
 * start always removes the {@link handOffMarker} its parent process wrote, the composed tree's start included. While
 * protection is off, the signed installation's start first applies every edit of the runtime's writable copy without
 * review, so the tree it composes runs them.
 * @param request - the home, the profile, the environment and the output.
 * @param dependencies - this process's runtime, entry and arguments, the store's check and the child.
 * @returns undefined when this process runs the start itself; `not-started` when the child exited with a failure before
 *   its start ran outside an update; otherwise `ran`, with this process's exit code set to the child's, or to
 *   {@link EXIT.failed} when a signal ended it.
 * @throws {CliError} when the signed installation fails its check, or the composed tree fails its check after it was
 *   rebuilt, or the child cannot be started; the start is refused.
 */
export async function handOffToComposedTree(request: HandOffRequest, dependencies: HandOffDependencies): Promise<HandOff | undefined> {
  const { runtime } = dependencies
  const { home, profile } = request
  rmSync(handOffMarker(home, profile, process.ppid), { force: true })
  let tree
  try {
    let signed: Promise<SignedRuntime> | undefined
    const signedOnce = (): Promise<SignedRuntime> => (signed ??= dependencies.signed(home, runtime.version, request.env))
    if (runtime.store && runtime.composed === undefined && readSafeMode(home, profile) === undefined) {
      unreviewedNotice(await applyUnreviewedHarnessChanges({ home, runtime: runtime.version, signed: signedOnce }), runtime.version, request.output)
    }
    if (!await handsOff(home, profile, runtime)) return undefined
    tree = await prepareComposedTree(home, runtime.version, await signedOnce())
  } catch (error) {
    if (error instanceof RuntimeStoreError) throw new CliError(EXIT.failed, `delorun: Delo ${runtime.version} was not started, because its files differ from the signed release: ${error.detail}. See what differs with: delorun verify`)
    if (isChangesError(error)) throw new CliError(EXIT.failed, `delorun: Delo ${runtime.version} was not started with your changes to it: ${error.detail}`)
    throw error
  }
  if (tree === undefined) return undefined
  const retained = await retainHarness(home, { runtime: runtime.version, keep: tree.digest, removeTrees: !dependencies.homeProcessRuns(home), installed: installedRuntimes(home) })
  for (const { path, error } of retained.failed) request.output.stderr(`Delo could not remove ${path}, which it no longer runs; the next start tries again: ${error}\n`)
  const command = startEntry(dependencies.running, tree.directory)
  const handover = dependencies.handover()
  const stdio: StdioOptions = handover ? ['inherit', 'inherit', 'inherit', HANDOVER_FD] : 'inherit'
  const marker = handOffMarker(home, profile, process.pid)
  mkdirSync(runDirectory(home, profile), { recursive: true, mode: 0o700 })
  writeFileSync(marker, '', { mode: 0o600 })
  let started: boolean
  let end: ChildExit
  try {
    end = await dependencies.run({ node: command.node, args: [command.entry, ...dependencies.args] }, request.env, stdio, 'delorun: Delo could not start the harness with your changes')
  } finally {
    started = !existsSync(marker)
    rmSync(marker, { force: true })
  }
  if (!started && !handover && end.code !== null && end.code !== EXIT.ok) return { kind: 'not-started', runtime: runtime.version, code: end.code }
  process.exitCode = end.code ?? EXIT.failed
  return { kind: 'ran', ran: undefined }
}

/**
 * C1's start check of the runtime a home process runs, as C3's health check H1 and a fresh start run it: the signed
 * installation's files against its signed file list, and for a process that runs a composed tree, that tree against the
 * signed release with the approved files in place.
 * @param home - the resolved Delo home.
 * @param version - the installed version.
 * @param logger - the home process's logger.
 * @param root - the stored root, anchored on the launcher's roots.
 * @param composed - the composed tree the process runs from, when it runs one.
 * @throws {RuntimeStoreError} when the installation's files do not match its signed file list.
 * @throws {ChangesError} `HARNESS_CHANGED` when the composed tree is not the one the records compose now, or differs.
 */
export async function checkRunningRuntime(home: string, version: RuntimeVersion, logger: DeloLogger, root: TrustedRootSource, composed?: string): Promise<void> {
  const verified = await checkStoredRuntime(home, version, logger, root)
  if (composed === undefined) return
  await checkComposedTree(home, version, signedRuntimeOf(installationOf(home, version), verified), composed)
}

/**
 * @param home - the Delo home.
 * @param version - an installed version.
 * @returns its installation, `runtimes/<version>/` of this machine's platform's store.
 */
function installationOf(home: string, version: RuntimeVersion): string {
  return new StorePaths(home, runtimePlatformOf(process.platform, process.arch)).version(version)
}
