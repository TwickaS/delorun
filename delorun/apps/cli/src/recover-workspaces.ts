/**
 * `delorun recover workspaces`: restores the workspace registry's previous good copy (`storages/workspace.json.previous`)
 * when the current registry file lost workspaces or does not read. It runs at this computer only, under the home lock
 * and as the only user of the shared stores, so no home process or device request can write the registry meanwhile. It
 * shows what the current file and the copy hold, asks first (`--yes` answers for a script), moves the current file aside
 * under a `.quarantined-` name, and writes the copy in its place. It deletes nothing, and the copy stays.
 * @module @delorun/cli/recover-workspaces
 */
import { fileURLToPath } from 'node:url'
import { confirm, isCancel } from '@clack/prompts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { setAsideFile } from '@deepseek-ai/dsh-storage-json'
import { acquireHomeLock, newStartId, runDirectory } from '@delorun/home'
import { updateChannelProbe } from '@delorun/home-process'
import { readFile } from 'node:fs/promises'
import { EXIT } from './exit.ts'
import type { CommandContext, CommandResult } from './command.ts'
import { assertSoleDataUser, registerDataUser } from './home-exclusion.ts'
import { runtimeOfFile } from './update/runtime.ts'
import { describeRegistry, readRegistryStore } from './workspace-store.ts'

/** Asks the person whether to restore. */
export type ConfirmRestore = (question: string) => Promise<boolean>

/**
 * The terminal's confirmation, which starts on no; without a terminal on both standard input and output, `undefined`.
 * @returns the confirmation, or `undefined` when no one can answer it.
 */
export function terminalRestoreConfirm(): ConfirmRestore | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined
  return async (question) => {
    const answer = await confirm({ message: question, initialValue: false })
    return !isCancel(answer) && answer
  }
}

/** What the restore reads besides the home. */
export interface RestoreRequest {
  /** The Delorun home. */
  readonly home: string
  /** The CLI profile whose home lock is taken. */
  readonly profile: string
  /** Whether `--yes` was given. */
  readonly yes: boolean
  /** The terminal's confirmation, or `undefined` without a terminal. */
  readonly confirm: ConfirmRestore | undefined
}

/**
 * Restore the registry's previous good copy.
 * @param request - the home, the profile, `--yes` and the confirmation.
 * @param context - the output.
 * @returns the exit code: 0 when restored, failed when there is no usable copy, no one answered or the answer was no.
 * @throws {HomeLayoutError} `HOME_RUNNING` while Delorun runs; {@link DataInUseError} while another process uses the stores.
 */
export async function recoverWorkspaces(request: RestoreRequest, context: CommandContext): Promise<CommandResult> {
  const { home, profile } = request
  const lock = await acquireHomeLock({ runDirectory: runDirectory(home, profile), runtime: runtimeOfFile(home, fileURLToPath(import.meta.url)).version, probe: updateChannelProbe(home, profile), startId: newStartId() })
  const release = registerDataUser(home, 'exclusive', 'recover')
  try {
    assertSoleDataUser(home)
    const store = await readRegistryStore(home)
    const { previous } = store
    if (previous.inspection === undefined) {
      context.stderr(`delorun recover workspaces: NO_BACKUP: there is no previous copy of the workspace registry (${previous.path}), so there is nothing to restore. Delorun keeps one after each change it makes to the registry.\n`)
      return EXIT.failed
    }
    if (previous.inspection.state === 'unreadable' || previous.inspection.problems.length > 0) {
      context.stderr(`delorun recover workspaces: BACKUP_UNUSABLE: the previous copy ${previous.path} holds ${describeRegistry(previous)}, so restoring it would not help. Nothing changed.\n`)
      return EXIT.failed
    }
    context.stdout(`The current registry ${store.current.path} holds: ${describeRegistry(store.current)}.\n`)
    context.stdout(`The previous copy holds: ${describeRegistry(previous)}.\n`)
    context.stdout('Restoring replaces the current file with the copy. The current file is moved aside under a .quarantined- name next to it, not deleted, and the copy stays.\n')
    if (!request.yes) {
      if (request.confirm === undefined) {
        context.stderr('delorun recover workspaces: needs your confirmation. Run it at a terminal to answer, or pass --yes. Nothing changed.\n')
        return EXIT.failed
      }
      if (!await request.confirm('Replace the current workspace registry with the previous copy?')) {
        context.stderr('delorun recover workspaces: you declined, so nothing changed.\n')
        return EXIT.failed
      }
    }
    if (store.current.inspection !== undefined) context.stdout(`Moved the current registry aside to ${await setAsideFile(store.current.path)}.\n`)
    await writeFileAtomic(store.current.path, await readFile(previous.path, 'utf8'), { mode: 0o600 })
    context.stdout(`Restored the workspace registry from ${previous.path}. Start Delorun with delorun start.\n`)
    return EXIT.ok
  } finally {
    release()
    lock.release()
  }
}
