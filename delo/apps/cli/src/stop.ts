/**
 * `delorun stop` (contract C19, "Commands"): sends the home process `stop` over the update channel. Without `--now`
 * the mode is `drain`: new turns are refused and running chats are waited for at most 1,800 seconds. `--now` sends
 * `cancel`, which cancels running turns and background jobs first. With no home process running, it prints that and
 * exits 0.
 *
 * A `--now` stop whose home process does not send its final line within {@link STOP_NOW_ANSWER_MS}, or closes the
 * channel without one, or has not exited {@link START_WAIT_MS} after accepting, is ended by signal: `SIGTERM`, then
 * `SIGKILL` once {@link STOP_TERM_GRACE_MS} pass. Each signal is sent only while the profile's lock still holds the
 * record read at the start and `checkHolder` confirms the live process as that record's holder: same process id, same
 * start identity and the same pid namespace where one is recorded. Every other case, Windows included, where no start
 * identity exists, is refused without a signal and named on standard error. A home process that refuses the stop is
 * not signalled. A drain stop never signals.
 *
 * @module @delo/cli/stop
 */
import { setTimeout as sleep } from 'node:timers/promises'
import type { HomeLockRecord } from '@delo/contract-home-layout'
import { START_WAIT_MS, STOP_KILL_WAIT_MS, STOP_NOW_ANSWER_MS, STOP_TERM_GRACE_MS } from '@delo/contract-home-process'
import { checkHolder, readHomeLock, resolveDeloHome, runDirectory, SYSTEM_PROCESS_TABLE, type HolderCheck, type ProcessTable, type UnconfirmedHolder } from '@delo/home'
import { sendHomeRequest } from '@delo/home-process'
import { EXIT, type ExitCode } from './exit.ts'
import { parseOptions, type CliCommand, type CommandOutput } from './command.ts'
import { selectProfile } from './profile.ts'

/** How often a stop checks whether the home process has exited, in milliseconds. */
const EXIT_POLL_MS = 100

/** A signal `delorun stop --now` sends. */
export type StopSignal = 'SIGTERM' | 'SIGKILL'

/** What `delorun stop` reads, sends and signals through. */
export interface StopDependencies {
  /** Sends a request over the update channel, as `sendHomeRequest` does. */
  readonly send: typeof sendHomeRequest
  /** Reads the profile's lock record, as `readHomeLock` does. */
  readonly readLock: typeof readHomeLock
  /** The processes the lock's holder is checked against. */
  readonly processes: ProcessTable
  /**
   * Send a signal to a process.
   * @param pid - the process id.
   * @param signal - the signal.
   * @throws the operating system's error, `ESRCH` when no process has the id.
   */
  readonly kill: (pid: number, signal: StopSignal) => void
  /**
   * The current time.
   * @returns milliseconds since the epoch.
   */
  readonly now: () => number
  /**
   * Wait.
   * @param ms - how long, in milliseconds.
   * @returns once the time has passed.
   */
  readonly sleep: (ms: number) => Promise<void>
}

/** This operating system's update channel, lock, processes, signals and clock. */
export const SYSTEM_STOP_DEPENDENCIES: StopDependencies = {
  send: sendHomeRequest,
  readLock: readHomeLock,
  processes: SYSTEM_PROCESS_TABLE,
  kill: (pid, signal) => { process.kill(pid, signal) },
  now: () => Date.now(),
  sleep: async (ms) => { await sleep(ms) },
}

/** What the lock and the process table say about the process a `--now` stop would signal (a closed union). */
type SignalTarget =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'refused', readonly why: string, readonly check: string }

/**
 * Why a holder that may run is not confirmed, and what the person checks.
 * @param reason - the check's reason.
 * @param record - the lock record.
 * @param processes - the process table, for its platform and pid namespace.
 * @returns the reason and what to check, each one sentence fragment.
 */
function unconfirmedText(reason: UnconfirmedHolder, record: HomeLockRecord, processes: ProcessTable): { readonly why: string, readonly check: string } {
  const pid = String(record.pid)
  const yourself = `Check that process ${pid} is delorun's home process before ending it yourself`
  switch (reason) {
    case 'no-start-reader':
      return { why: `on ${processes.platform} Delo records no start identity for a process, so it cannot tell the home process from another process that reuses the id ${pid}`, check: yourself }
    case 'no-start-identity':
      return { why: `the profile's lock records no start identity for process ${pid}, so it cannot be told from another process that reuses the id`, check: yourself }
    case 'other-namespace':
      return { why: `the profile's lock records process ${pid} in the pid namespace ${record.pidNamespace ?? ''}, and this command's is ${processes.pidNamespace() ?? 'unreadable'}, so the id names another process here`, check: `Stop it from the container or sandbox it runs in` }
    case 'start-unreadable':
      return { why: `the start identity of process ${pid} cannot be read now`, check: yourself }
    default: {
      const unknown: never = reason
      throw new Error(`unknown reason ${String(unknown)}`)
    }
  }
}

/**
 * Whether the process a `--now` stop would signal is still the profile's lock holder.
 * @param record - the lock record read at the start.
 * @param directory - the profile's run directory.
 * @param dependencies - the lock reader and process table.
 * @param signalled - whether a signal was already sent: a replaced process id then means the holder exited.
 * @returns `confirmed` only when the lock still holds the record and its holder is confirmed.
 */
function signalTarget(record: HomeLockRecord, directory: string, dependencies: StopDependencies, signalled: boolean): SignalTarget {
  const pid = String(record.pid)
  const check: HolderCheck = checkHolder(record, dependencies.processes)
  switch (check.kind) {
    case 'exited':
      return { kind: 'gone' }
    case 'replaced':
      return signalled ? { kind: 'gone' } : { kind: 'refused', why: `process ${pid} has another start identity than the profile's lock records, so it is another process that reuses the id`, check: `Run delorun status to see whether Delo still runs` }
    case 'unconfirmed':
      return { kind: 'refused', ...unconfirmedText(check.reason, record, dependencies.processes) }
    case 'confirmed':
      break
    default: {
      const unknown: never = check
      throw new Error(`unknown holder check ${String(unknown)}`)
    }
  }
  let current: HomeLockRecord | undefined
  try {
    current = dependencies.readLock(directory)
  } catch (error) {
    return { kind: 'refused', why: `the profile's lock cannot be read: ${error instanceof Error ? error.message : String(error)}`, check: `Check the lock file in ${directory}` }
  }
  if (current?.startId !== record.startId || current.pid !== record.pid) {
    return { kind: 'refused', why: `the profile's lock no longer names process ${pid}${current === undefined ? '' : `; it names process ${String(current.pid)}`}`, check: `Run delorun status to see whether Delo still runs` }
  }
  return { kind: 'confirmed' }
}

/**
 * Wait for a process to exit.
 * @param stillThere - whether it still runs.
 * @param waitMs - the longest wait.
 * @param dependencies - the clock.
 * @returns true once it no longer runs, false when the wait ends first.
 */
async function waitUntilGone(stillThere: () => boolean, waitMs: number, dependencies: StopDependencies): Promise<boolean> {
  const deadline = dependencies.now() + waitMs
  while (stillThere()) {
    if (dependencies.now() >= deadline) return false
    await dependencies.sleep(EXIT_POLL_MS)
  }
  return true
}

/**
 * Send a signal, reading `ESRCH` as a process that has already exited.
 * @param pid - the process id.
 * @param signal - the signal.
 * @param dependencies - the killer.
 * @returns `sent`, `gone`, or the error that prevented sending.
 */
function sendSignal(pid: number, signal: StopSignal, dependencies: StopDependencies): 'sent' | 'gone' | { readonly error: string } {
  try {
    dependencies.kill(pid, signal)
    return 'sent'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * End a home process that did not stop when asked, by `SIGTERM` and then `SIGKILL`, each sent only to the confirmed
 * lock holder.
 * @param record - the lock record read at the start.
 * @param directory - the profile's run directory.
 * @param profile - the CLI profile, for the messages.
 * @param failure - why the stop request did not stop it.
 * @param output - where the outcome is written.
 * @param dependencies - the lock reader, process table, killer and clock.
 * @returns `ok` once the process has exited, `failed` when it was not signalled or did not exit.
 */
async function endBySignal(record: HomeLockRecord, directory: string, profile: string, failure: string, output: CommandOutput, dependencies: StopDependencies): Promise<ExitCode> {
  const pid = String(record.pid)
  const stopped = `Delo stopped for the profile ${profile}.\n`
  const gone = (): boolean => { const { kind } = checkHolder(record, dependencies.processes); return kind === 'exited' || kind === 'replaced' }
  const refuse = (target: Extract<SignalTarget, { kind: 'refused' }>, signal: StopSignal): ExitCode => {
    output.stderr(`delorun stop: process ${pid} ${failure}, and Delo did not send it ${signal}: ${target.why}. ${target.check}.\n`)
    return EXIT.failed
  }
  for (const [signal, waitMs] of [['SIGTERM', STOP_TERM_GRACE_MS], ['SIGKILL', STOP_KILL_WAIT_MS]] as const) {
    const target = signalTarget(record, directory, dependencies, signal === 'SIGKILL')
    if (target.kind === 'gone') {
      output.stdout(stopped)
      return EXIT.ok
    }
    if (target.kind === 'refused') return refuse(target, signal)
    const sent = sendSignal(record.pid, signal, dependencies)
    if (sent === 'gone') {
      output.stdout(stopped)
      return EXIT.ok
    }
    if (sent !== 'sent') {
      output.stderr(`delorun stop: process ${pid} ${failure}, and sending it ${signal} failed: ${sent.error}\n`)
      return EXIT.failed
    }
    output.stdout(signal === 'SIGTERM' ? `Process ${pid} ${failure}; sent it SIGTERM.\n` : `Process ${pid} had not exited ${String(STOP_TERM_GRACE_MS / 1000)} seconds after SIGTERM; sent it SIGKILL.\n`)
    if (await waitUntilGone(() => !gone(), waitMs, dependencies)) {
      output.stdout(`Process ${pid} exited after ${signal}. ${stopped}`)
      return EXIT.ok
    }
  }
  output.stderr(`delorun stop: process ${pid} still runs ${String(STOP_KILL_WAIT_MS / 1000)} seconds after SIGKILL\n`)
  return EXIT.failed
}

/**
 * The `stop` command.
 * @param dependencies - the update channel, lock, processes, signals and clock it uses.
 * @returns the command.
 */
export function createStopCommand(dependencies: StopDependencies): CliCommand {
  return {
    name: 'stop',
    summary: 'Stop the home process once running chats end, or at once with --now',
    async run(args, context) {
      const values = parseOptions('stop', args, { now: { type: 'boolean', default: false }, profile: { type: 'string' } })
      const now = values.now === true
      const profile = selectProfile(values.profile, context.env)
      const home = await resolveDeloHome(context.env)
      const directory = runDirectory(home.path, profile)
      const record = dependencies.readLock(directory)
      const holderRuns = (): boolean => record !== undefined && !['exited', 'replaced'].includes(checkHolder(record, dependencies.processes).kind)
      if (record === undefined || !holderRuns()) {
        context.stdout(`Delo is not running for the profile ${profile}.\n`)
        return EXIT.ok
      }
      let lines
      try {
        lines = await dependencies.send(home.path, profile, { op: 'stop', args: { mode: now ? 'cancel' : 'drain' } }, {
          onLine: (line) => {
            if (line.ok && typeof line.chats === 'number' && line.chats > 0) context.stdout(`Waiting for ${String(line.chats)} running chat(s) to end…\n`)
          },
          ...now ? { timeoutMs: STOP_NOW_ANSWER_MS } : {},
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (now) return endBySignal(record, directory, profile, `did not answer the stop over its update channel (${message})`, context, dependencies)
        context.stderr(`delorun stop: process ${String(record.pid)} holds the profile's lock but its update channel did not answer: ${message}\n`)
        return EXIT.failed
      }
      const final = lines.at(-1)
      if (now && final === undefined) return endBySignal(record, directory, profile, 'closed its update channel without answering the stop', context, dependencies)
      if (final?.ok !== true) {
        context.stderr(`delorun stop: the home process refused to stop: ${String(final?.error ?? 'no answer')}${typeof final?.detail === 'string' ? ` (${final.detail})` : ''}\n`)
        return EXIT.failed
      }
      if (await waitUntilGone(() => holderRuns() && dependencies.readLock(directory)?.startId === record.startId, START_WAIT_MS, dependencies)) {
        context.stdout(`Delo stopped for the profile ${profile}.\n`)
        return EXIT.ok
      }
      if (now) return endBySignal(record, directory, profile, `accepted the stop but had not exited ${String(START_WAIT_MS / 1000)} seconds later`, context, dependencies)
      context.stderr(`delorun stop: process ${String(record.pid)} accepted the stop but has not exited\n`)
      return EXIT.failed
    },
  }
}

/** `delorun stop [--now] [--profile <name>]`. */
export const stopCommand: CliCommand = createStopCommand(SYSTEM_STOP_DEPENDENCIES)
