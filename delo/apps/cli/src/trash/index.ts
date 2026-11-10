/**
 * `delorun trash` (contract C8): list what the trash holds, restore an item,
 * delete one forever, or empty the trash. The trash lives under the home at
 * `trash/`; a deleted chat's session directory sits there until it is
 * restored or purged. Restoring and purging change the stores the home
 * process uses, so they are refused while it runs, and the person uses the
 * studio's Trash section instead. Deleting forever asks first, states that
 * fragments may remain in the operational logs for up to 14 days, and clears
 * those logs at once only with `--clear-logs`.
 *
 * @module @delo/cli/trash
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { PURGE_RESIDUE_MAX_DAYS, TRASH_RETENTION_DAYS } from '@delo/contract-archive-and-trash'
import { DAY_MS, TrashError, TrashService, type TrashItem } from '@delo/trash'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { isYes } from './terminal.ts'

/** The usage line. */
export const TRASH_USAGE = 'Usage: delorun trash list [--json] | restore <id> | purge <id> [--clear-logs] | empty [--clear-logs] [--profile <name>]'

/** What `delorun trash` runs with. */
export interface TrashIo {
  /** The Delo home. */
  readonly home: string
  /** Write to standard output. */
  readonly stdout: (text: string) => void
  /** Ask one question; the empty string when no terminal can ask. */
  readonly ask: (question: string) => Promise<string>
  /** Whether the profile's home process runs now. */
  readonly homeRunning: () => boolean
  /** The current time, in epoch milliseconds. */
  readonly now: () => number
}

/**
 * The trash service over the home's stores. A purge from the terminal reaches
 * the session generations, the projection cache's documents and the
 * operational logs; the full-text index of the shipped profile lives in the
 * home process's memory only, so nothing of it is on disk to purge.
 * @param home - the Delo home.
 * @returns the service.
 */
export function homeTrash(home: string): TrashService {
  return new TrashService({
    root: join(home, 'trash'),
    stores: { sessionsRoot: join(home, 'sessions'), storagesRoot: join(home, 'storages'), logsHome: home },
  })
}

/**
 * One item as a line of the listing.
 * @param item - the item.
 * @param now - the current time.
 * @returns the line.
 */
function itemLine(item: TrashItem, now: number): string {
  const left = Math.max(0, Math.ceil((item.expiresAt - now) / DAY_MS))
  const chats = item.kind === 'workspace' ? `, ${String(item.sessionIds.length)} chat${item.sessionIds.length === 1 ? '' : 's'}` : ''
  return `${item.id}  ${item.kind}${chats}  ${JSON.stringify(item.label)}  deleted ${new Date(item.deletedAt).toISOString()}, deleted forever in ${String(left)} day${left === 1 ? '' : 's'}`
}

/**
 * Run `delorun trash`.
 * @param args - the arguments after `trash`, without `--profile`.
 * @param io - the home, the output, the question and the clock.
 * @returns the exit code.
 * @throws {CliError} for a wrong command line, a running home process, a declined purge or a refused item.
 */
export async function runTrash(args: readonly string[], io: TrashIo): Promise<ExitCode> {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: { 'json': { type: 'boolean' }, 'clear-logs': { type: 'boolean' } }, strict: true, allowPositionals: true })
  } catch (error: unknown) {
    throw new CliError(EXIT.usage, `delorun trash: ${(error as Error).message}\n${TRASH_USAGE}`)
  }
  const [action, id, ...extra] = parsed.positionals
  const wants = (count: number): void => {
    if ((count === 1 ? id === undefined : id !== undefined) || extra.length > 0) throw new CliError(EXIT.usage, TRASH_USAGE)
  }
  const trash = homeTrash(io.home)
  if (action === 'list') {
    wants(0)
    const items = await trash.list(io.now())
    if (parsed.values.json === true) {
      io.stdout(`${JSON.stringify({ retentionDays: TRASH_RETENTION_DAYS, items: items.map(({ id: itemId, kind, label, deletedAt, expiresAt, sessionIds, workspaceIds }) => ({ id: itemId, kind, label, deletedAt, expiresAt, sessionIds, workspaceIds })) })}\n`)
      return EXIT.ok
    }
    io.stdout(items.length === 0
      ? `The trash is empty. Deleted chats and workspaces stay here for ${String(TRASH_RETENTION_DAYS)} days.\n`
      : `${items.map(item => itemLine(item, io.now())).join('\n')}\n`)
    return EXIT.ok
  }
  if (action !== 'restore' && action !== 'purge' && action !== 'empty') throw new CliError(EXIT.usage, TRASH_USAGE)
  wants(action === 'empty' ? 0 : 1)
  if (io.homeRunning()) {
    throw new CliError(EXIT.failed, `delorun trash ${action}: the home process is running and uses these stores; use the Trash section in the studio's Settings, or run delorun stop first`)
  }
  try {
    if (action === 'restore') {
      const item = await trash.restore(id!)
      io.stdout(`Restored ${item.kind} ${JSON.stringify(item.label)}. A chat the studio archived for the delete stays archived until you unarchive it.\n`)
      return EXIT.ok
    }
    const items = action === 'empty' ? await trash.list(io.now()) : (await trash.list(io.now())).filter(item => item.id === id)
    if (action === 'purge' && items.length === 0) throw new TrashError('TRASH_ITEM_NOT_FOUND', `no trash item carries the id "${id!}"`)
    if (items.length === 0) {
      io.stdout('The trash is empty.\n')
      return EXIT.ok
    }
    const what = action === 'empty' ? `every item in the trash (${String(items.length)})` : `${items[0]!.kind} ${JSON.stringify(items[0]!.label)}`
    const answer = await io.ask(`Delete ${what} forever? It is removed from every place Delo keeps it and cannot be restored. [y/N] `)
    if (!isYes(answer)) throw new CliError(EXIT.failed, `delorun trash ${action}: nothing was deleted`)
    const clearLogs = parsed.values['clear-logs'] === true
    let cleared = false
    for (const item of items) {
      const report = await trash.purge(item.id, { clearLogs: clearLogs && !cleared })
      cleared ||= report.logs.cleared
      io.stdout(`Deleted ${item.kind} ${JSON.stringify(item.label)} forever, from: ${report.removedFrom.join(', ')}.\n`)
    }
    io.stdout(cleared
      ? 'The operational logs were cleared, so no fragment of it remains in them.\n'
      : `Fragments may remain in the operational logs for up to ${String(PURGE_RESIDUE_MAX_DAYS)} days; delorun logs --clear removes them now.\n`)
    return EXIT.ok
  } catch (error: unknown) {
    if (error instanceof TrashError) throw new CliError(EXIT.failed, `delorun trash ${action}: ${error.message}`)
    throw error
  }
}
