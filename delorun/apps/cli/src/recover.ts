/**
 * `delorun recover` (contract C3): the command a person runs when an update failed or a plugin broke the start. One
 * action per run:
 *
 * | Action | What it does |
 * | --- | --- |
 * | `status` (the default) | the profile's last update, its snapshot and history, safe mode, the update record, and every session-data copy and set-aside directory with its size |
 * | `rollback [--profile-only]` | goes back from the recorded update through C3's one rollback function and its table: through the home process when one runs, otherwise under the home lock here and, unless `--profile-only`, as the only user of the shared stores; `--profile-only` restores the profile snapshot and keeps the runtime |
 * | `restore <version>` | brings back a named profile history version |
 * | `safe-mode [--reason <text>]`, `exit-safe-mode` | starts without third-party plugins, and ends it |
 * | `discard <path>` | removes one copy or set-aside directory `status` lists |
 * | `workspaces [--yes]` | restores the workspace registry's previous good copy after showing what it replaces and asking; the current file is moved aside, never deleted |
 *
 * A rollback, with or without a home process, refuses with C19's `GIT_UNAVAILABLE` before any step when git, which
 * restores the profile, cannot run. A runtime rollback with no home process running then registers as an exclusive user
 * of the shared stores, refuses while another process uses them, completes an interrupted restore of a session-data
 * copy, then reads the update record and applies the table; it never swaps the runtime pointers on its own.
 *
 * @module @delorun/cli/recover
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { discardImportReviews } from '@delorun/changes/setup-transfer'
import { DELORUN_PROFILE_BUNDLES } from '@delorun/bundle-local/profile'
import { HOME_STATUS_TIMEOUT_MS } from '@delorun/contract-home-layout'
import { acquireHomeLock, newStartId, runDirectory } from '@delorun/home'
import type { DelorunLogger } from '@delorun/logs'
import { journalPath, queryHomeStatus, readJournal, removeJournal, removeStash, sendHomeRequest, stashPath, updateChannelProbe, writeJournal } from '@delorun/home-process'
import { recover, type RecoverAction, type RecoverReport } from '@delorun/profile-safety'
import { isStoreError, RuntimeStore, type TrustedRootSource } from '@delorun/runtime-store'
import { discardKeptData, listKeptData, recoverDataCopies } from '@delorun/update'
import type { ProfileVersionId } from '@deepseek-ai/dsh-plugin-manager/history'
import { CliError, EXIT } from './exit.ts'
import { parseFailure, prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { assertSoleDataUser, registerDataUser } from './home-exclusion.ts'
import { recoverPacks } from './recover-packs.ts'
import { recoverWorkspaces, terminalRestoreConfirm } from './recover-workspaces.ts'
import { helpPointer } from './help.ts'
import { withReadableTimes } from './output.ts'
import { cliRedactor } from './refusals.ts'
import { removeSafeModeOverlay } from './safe-mode.ts'
import { runtimeOfFile } from './update/runtime.ts'
import { runtimePlatformOf } from './update/channel.ts'
import { assertHistoryGit, rollbackRecordedUpdate } from './update/support.ts'
import { launcherAnchor } from './update/trusted-root.ts'

/** The options `delorun recover` takes. */
const RECOVER_OPTIONS = {
  profile: { type: 'string' },
  'profile-only': { type: 'boolean' },
  reason: { type: 'string' },
  json: { type: 'boolean' },
  yes: { type: 'boolean' },
} as const

/** The store's retention reports nothing here: a rollback removes no installation. */
export const SILENT: DelorunLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

/** The actions, in usage order. */
const ACTIONS = ['status', 'rollback', 'restore', 'safe-mode', 'exit-safe-mode', 'discard', 'workspaces', 'packs'] as const

/** One action and its argument. */
type Requested =
  | { readonly kind: 'status' }
  | { readonly kind: 'rollback', readonly profileOnly: boolean }
  | { readonly kind: 'restore', readonly version: string }
  | { readonly kind: 'safe-mode', readonly reason: string }
  | { readonly kind: 'exit-safe-mode' }
  | { readonly kind: 'discard', readonly path: string }
  | { readonly kind: 'workspaces', readonly yes: boolean }
  | { readonly kind: 'packs' }

/**
 * Read the action from the command line.
 * @param args - the arguments after `recover`.
 * @returns the action and the options.
 * @throws {CliError} with the usage code for an unknown action, a missing argument or an option another action owns.
 */
function requested(args: readonly string[]): { readonly action: Requested, readonly profile: string | undefined, readonly json: boolean } {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: RECOVER_OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    throw parseFailure('recover', error)
  }
  const [name = 'status', argument, ...extra] = parsed.positionals
  const known = ACTIONS.find(action => action === name)
  const needsArgument = known === 'restore' || known === 'discard'
  if (known === undefined || extra.length > 0 || needsArgument !== (argument !== undefined)) throw new CliError(EXIT.usage, `delorun recover: ${JSON.stringify(parsed.positionals.join(' '))} is not an action. ${helpPointer('recover')}`)
  if (parsed.values['profile-only'] === true && known !== 'rollback') throw new CliError(EXIT.usage, `delorun recover: --profile-only belongs to rollback. ${helpPointer('recover')}`)
  if (parsed.values.reason !== undefined && known !== 'safe-mode') throw new CliError(EXIT.usage, `delorun recover: --reason belongs to safe-mode. ${helpPointer('recover')}`)
  if (parsed.values.yes === true && known !== 'workspaces') throw new CliError(EXIT.usage, `delorun recover: --yes belongs to workspaces. ${helpPointer('recover')}`)
  const action: Requested = known === 'rollback' ? { kind: 'rollback', profileOnly: parsed.values['profile-only'] === true }
    : known === 'restore' ? { kind: 'restore', version: argument! }
      : known === 'safe-mode' ? { kind: 'safe-mode', reason: parsed.values.reason ?? 'the person asked for safe mode' }
        : known === 'discard' ? { kind: 'discard', path: argument! }
          : known === 'workspaces' ? { kind: 'workspaces', yes: parsed.values.yes === true }
            : { kind: known }
  return { action, profile: parsed.values.profile, json: parsed.values.json === true }
}

/**
 * Whether the profile's home process answers.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns true when it answers `status`.
 */
async function homeRunning(home: string, profile: string): Promise<boolean> {
  try {
    await queryHomeStatus(home, profile, HOME_STATUS_TIMEOUT_MS)
    return true
  } catch (_notRunning) {
    // No token, socket or answer: no home process runs for the profile.
    return false
  }
}

/**
 * The lines `status` adds about the update record and the kept chat data.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns the lines.
 */
async function updateLines(home: string, profile: string): Promise<string[]> {
  const record = await readJournal(journalPath(home, profile))
  const lines = record === undefined
    ? ['No update is recorded for a rollback.']
    : [`The recorded update from Delorun ${record.from} to Delorun ${record.to} is ${record.phase}; the chat data ${record.dataDiffers ? 'changes format' : 'keeps its format'}${record.dataDiffers ? `, and ${record.copy ? 'a copy was taken' : 'no copy was taken'}` : ''}.`]
  for (const kept of await listKeptData(home)) lines.push(`${kept.kind === 'copy' ? 'Chat-data copy' : kept.kind === 'runtimes' ? 'Set-aside program store' : 'Set-aside chat data'}: ${kept.path} (${String(kept.bytes)} bytes); remove it with delorun recover discard ${kept.path}.`)
  return lines
}

/**
 * The lines `recover status` prints: the report's, with readable times, then the update record, then only the actions
 * that can run now.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param report - the status report.
 * @returns the lines.
 */
async function statusOutput(home: string, profile: string, report: RecoverReport): Promise<string[]> {
  const facts = report.lines.filter(line => !line.startsWith('Run `delorun recover')).map(line => withReadableTimes(line))
  const flag = profile === 'default' ? '' : ` --profile ${profile}`
  const actions = [
    ...report.lastUpdate === undefined ? [] : [['delorun recover rollback', 'go back to the version before the last update']],
    ...report.versions.length === 0 ? [] : [['delorun recover restore <version>', 'go back to an earlier profile version']],
    ...report.safeMode === undefined ? [['delorun recover safe-mode', 'start without third-party plugins']] : [['delorun recover exit-safe-mode', 'end safe mode']],
  ].map(([command, what]) => [`${command}${flag}`, what] as const)
  const width = Math.max(0, ...actions.map(([command]) => command.length))
  return [...facts, ...await updateLines(home, profile).then(lines => lines.map(line => withReadableTimes(line))), ...actions.length === 0 ? [] : ['', ...actions.map(([command, what]) => `  ${command.padEnd(width)}  ${what}`)]]
}

/**
 * `rollback` with no home process: refuse with `GIT_UNAVAILABLE` before anything when git cannot run, then under the
 * home lock read the update record and apply C3's table, switching the pointers from the record's target to its source.
 *
 * A runtime rollback restores the whole home's chat data and switches `current`, so from right after it takes the lock
 * until it ends it is registered as an exclusive user of the shared stores ([home exclusion](./home-exclusion.ts)): it
 * refuses while any other process is registered, another profile's home process included, and a home process that
 * starts while it runs refuses. Only then does it complete an interrupted restore of a session-data copy. A profile-only
 * rollback reads and writes only this profile's files, which its home lock covers, so it registers nothing and leaves
 * an interrupted restore to the next start, whose pre-start step completes it.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param profileOnly - restore only the profile snapshot.
 * @param context - the output.
 * @param root - the stored root the version rolled back to is checked under.
 * @returns the exit code.
 * @throws {HomeProcessError} `GIT_UNAVAILABLE` when git cannot run; {@link DataInUseError} for a runtime rollback
 *   while another process uses the chat data; nothing has changed then.
 */
export async function rollbackOffline(home: string, profile: string, profileOnly: boolean, context: CommandContext, root: TrustedRootSource): Promise<CommandResult> {
  await assertHistoryGit()
  const store = new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger: SILENT })
  const current = await store.pointers().then(pointers => pointers.current, (error: unknown) => {
    // A home without an installed runtime, as a source checkout runs: no update can be recorded against it.
    if (isStoreError(error, 'NO_ACTIVE_RUNTIME')) return undefined
    throw error
  })
  const lock = await acquireHomeLock({ runDirectory: runDirectory(home, profile), runtime: current ?? runtimeOfFile(home, fileURLToPath(import.meta.url)).version, probe: updateChannelProbe(home, profile), startId: newStartId() })
  let release = (): void => {}
  try {
    if (!profileOnly) {
      release = registerDataUser(home, 'exclusive', 'recover')
      assertSoleDataUser(home)
      await recoverDataCopies(home)
    }
    const path = journalPath(home, profile)
    const record = await readJournal(path)
    // The record's target runs, or `current` is unreadable, or a rollback that began is to be completed: it began when
    // the pointers named the target, and they name the source once it has switched them, so any other `current` is no
    // rollback of this record, and nothing is restored before this refusal.
    const applies = record !== undefined && (current === undefined || current === record.to || (record.phase === 'rolling-back' && current === record.from))
    if (record === undefined || !applies) {
      if (!profileOnly) {
        context.stderr('delorun recover: NO_UPDATE_RECORD: no update to the running release is recorded, so there is nothing to roll back; delorun recover rollback --profile-only restores the latest profile snapshot.\n')
        return EXIT.failed
      }
      const report = await recover({ profileDir: join(home, 'profiles', profile), homeDir: home, profile, action: { kind: 'rollback' }, changedBy: { kind: 'person' } })
      for (const line of report.lines) context.stdout(`${line}\n`)
      return EXIT.ok
    }
    const switchRuntime = async (): Promise<void> => {
      if (current === record.from) return
      // A `current` that names no installed runtime is replaced whole; otherwise the two pointers swap.
      if (current === undefined) await store.restore({ current: record.from })
      else await store.switchTo(record.to, record.from)
    }
    const markRollingBack = (): Promise<void> => writeJournal(path, { ...record, previous: record.previous }, 'rolling-back')
    const result = await rollbackRecordedUpdate({ home, profile, store, root, now: () => new Date() }, record, { profileOnly, switchRuntime, markRollingBack })
    // A profile-only rollback keeps the running release, which ends the update and the previous update's way back;
    // a runtime rollback's record goes once the version rolled back to starts healthy.
    if (profileOnly) {
      await removeJournal(path)
      await removeStash(path)
    }
    for (const line of result.lines) context.stdout(`${line}\n`)
    if (!profileOnly) context.stdout(`Start Delorun with delorun start; the rollback completes once Delorun ${record.from} starts healthy.\n`)
    return EXIT.ok
  } finally {
    release()
    lock.release()
  }
}

/**
 * `discard`: under the home lock, remove one copy or set-aside directory, never one a restore or a rollback is using
 * and never a copy an update record still refers to.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param path - the entry, as `status` lists it.
 * @param context - the output.
 * @returns the exit code.
 * @throws {DataSafetyError} `DATA_IN_USE` or `NOT_KEPT_DATA`; {@link HomeLayoutError} `HOME_RUNNING` while Delorun runs.
 */
async function discard(home: string, profile: string, path: string, context: CommandContext): Promise<CommandResult> {
  const lock = await acquireHomeLock({ runDirectory: runDirectory(home, profile), runtime: runtimeOfFile(home, fileURLToPath(import.meta.url)).version, probe: updateChannelProbe(home, profile), startId: newStartId() })
  try {
    const records = [await readJournal(journalPath(home, profile)), await readJournal(stashPath(journalPath(home, profile)))]
    const referenced = records.flatMap(record => record?.copy === true ? [record.to] : [])
    await discardKeptData(home, path, { referenced, rollingBack: records.some(record => record?.phase === 'rolling-back') })
    context.stdout(`Removed ${path}.\n`)
    return EXIT.ok
  } finally {
    lock.release()
  }
}

/**
 * `rollback` through the running home process.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param profileOnly - restore only the profile snapshot.
 * @param context - the output.
 * @returns the exit code.
 */
async function rollbackLive(home: string, profile: string, profileOnly: boolean, context: CommandContext): Promise<CommandResult> {
  const lines = await sendHomeRequest(home, profile, { op: 'rollback', args: { wait: 'drain', profileOnly } }, {
    onLine: (line) => { if (line.ok && typeof line.phase === 'string') context.stdout(`… ${line.phase}\n`) },
  })
  const final = lines.at(-1)
  if (final?.ok !== true) {
    context.stderr(cliRedactor().text(`delorun recover: ${String(final?.error ?? 'no answer')}${typeof final?.detail === 'string' ? `: ${final.detail}` : ''}\n`))
    return EXIT.failed
  }
  if (final.outcome === 'rolled-back' && Array.isArray(final.lines)) for (const line of final.lines) context.stdout(`${String(line)}\n`)
  context.stdout(final.outcome === 'rolled-back' ? 'Rolled back.\n' : `The rollback ended ${String(final.outcome)}${typeof final.reason === 'string' ? ` (${final.reason})` : ''}.\n`)
  return final.outcome === 'rolled-back' ? EXIT.ok : EXIT.failed
}

/** `delorun recover`: where the profile stands, and the ways back contract C3 offers. */
export const recoverCommand: CliCommand = {
  name: 'recover',
  summary: 'Where the profile stands after an update, and the way back: status, rollback [--profile-only], restore <version>, safe-mode, exit-safe-mode, discard <path>, workspaces [--yes], packs',
  /**
   * Run `delorun recover`.
   * @param args - the arguments after `recover`.
   * @param context - the environment and output.
   * @returns the action's exit code: 0 when it ran.
   * @throws {ProfileSafetyError}, {DataSafetyError} or {RuntimeStoreError} when the action is refused; `delorun`'s
   *   entry point reports it with its remedies.
   */
  async run(args: readonly string[], context: CommandContext): Promise<CommandResult> {
    const { action, profile: profileFlag, json } = requested(args)
    const { home, profile } = await prepareHome(context, profileFlag, false)
    switch (action.kind) {
      case 'rollback':
        return await homeRunning(home.path, profile)
          ? await rollbackLive(home.path, profile, action.profileOnly, context)
          : await rollbackOffline(home.path, profile, action.profileOnly, context, launcherAnchor(home.path, context.env).root)
      case 'discard':
        return await discard(home.path, profile, action.path, context)
      case 'packs':
        return await recoverPacks(home.path, context)
      case 'workspaces':
        return await recoverWorkspaces({ home: home.path, profile, yes: action.yes, confirm: terminalRestoreConfirm() }, context)
      default:
        break
    }
    const recoverAction: RecoverAction = action.kind === 'restore' ? { kind: 'restore', version: action.version as ProfileVersionId } : action
    const report = await recover({
      profileDir: join(home.path, 'profiles', profile),
      homeDir: home.path,
      profile,
      action: recoverAction,
      installationBundles: DELORUN_PROFILE_BUNDLES,
      changedBy: { kind: 'person' },
    })
    // Going back to the version saved before a setup import takes away the code reviews that import created.
    if (action.kind === 'restore') await discardImportReviews({ home: home.path, profile, profileDir: join(home.path, 'profiles', profile) }, action.version)
    // Ending safe mode takes the overlay a safe-mode start wrote with it.
    if (action.kind === 'exit-safe-mode') removeSafeModeOverlay(home.path, profile)
    const lines = action.kind === 'status' ? await statusOutput(home.path, profile, report) : report.lines
    if (json) context.stdout(JSON.stringify({ ...report, lines }, undefined, 2) + '\n')
    else for (const line of lines) context.stdout(`${line}\n`)
    return EXIT.ok
  },
}
