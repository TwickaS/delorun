/**
 * `delorun trash` (contract C8): list what the trash holds, restore a chat,
 * delete one item forever, or empty the trash. The trash lives under the home
 * at `trash/`; a deleted chat's session directory sits there until it is
 * restored or purged. Restoring and purging change the stores every home
 * process uses, so they run while this process holds the home lock of every
 * profile, and are refused while a home process runs; the person then uses
 * the studio's Trash section instead. Before either, chats a crash left at
 * their origin are moved into the trash, as a home process does at start.
 *
 * A workspace is restored in the studio only, because a restore registers it
 * again in the workspace list, which the home process owns. Deleting forever
 * asks first, removes the item's chats, the attachments no other chat or trash
 * item names and the item's spill files, and reports each store it reached.
 * Fragments may remain in the operational logs for up to 14 days;
 * `--clear-logs` clears every operational log of the home at once, not only
 * the item's records, and every log it could not clear is reported.
 *
 * @module @delorun/cli/trash
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { PURGE_RESIDUE_MAX_DAYS, TRASH_RETENTION_DAYS } from '@delorun/contract-archive-and-trash'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import { DAY_MS, TrashError, TrashService, type DamagedItem, type PurgeReport, type TrashItem } from '@delorun/trash'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseFailure } from '../command.ts'
import { helpPointer } from '../help.ts'
import { quoted } from '../terminal-text.ts'
import { isYes } from './terminal.ts'

/** The usage line. */
export const TRASH_USAGE = 'Usage: delorun trash list [--json] | restore <id> | purge <id> [--clear-logs] | empty [--clear-logs] [--profile <name>]'

/** What `delorun trash` runs with. */
export interface TrashIo {
  /** The Delorun home. */
  readonly home: string
  /** Write to standard output. */
  readonly stdout: (text: string) => void
  /** Ask one question; the empty string when no terminal can ask. */
  readonly ask: (question: string) => Promise<string>
  /** Run one change while this process holds every profile's home lock; refuses while a home process runs. */
  readonly exclusive: <T>(run: () => Promise<T>) => Promise<T>
  /** The current time, in epoch milliseconds. */
  readonly now: () => number
}

/**
 * The trash service over the home's stores. A purge from the terminal reaches
 * the session generations, the projection cache's documents, the attachment
 * store, the spill root `<home>/spill` and the operational logs; the
 * full-text index of the shipped profile lives in the home process's memory
 * only, so nothing of it is on disk to purge.
 * @param home - the Delorun home.
 * @returns the service.
 */
export function homeTrash(home: string): TrashService {
  return new TrashService({
    root: join(home, DELORUN_HOME_ENTRIES.trash),
    stores: {
      sessionsRoot: join(home, 'sessions'),
      storagesRoot: join(home, 'storages'),
      attachmentsRoot: join(home, 'attachments', 'v1'),
      spillRoots: [join(home, 'spill')],
      logsHome: home,
    },
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
  const chats = item.kind === 'workspace' ? `, ${plural(item.sessionIds.length, 'chat')}` : ''
  return `${item.id}  ${item.kind}${chats}  ${quoted(item.label)}  deleted ${new Date(item.deletedAt).toISOString()}, deleted forever in ${plural(left, 'day')}`
}

/**
 * The damaged item directories as lines.
 * @param damaged - the directories.
 * @returns the lines, with a heading; empty for none.
 */
function damagedLines(damaged: readonly DamagedItem[]): string {
  if (damaged.length === 0) return ''
  return `Damaged items: nothing restores, deletes or expires these; inspect each directory:\n${damaged.map(entry => `  ${entry.directory}: ${entry.reason}`).join('\n')}\n`
}

/**
 * A count with its noun.
 * @param count - the count.
 * @param noun - the singular noun.
 * @returns `1 chat`, `2 chats`.
 */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The line that states what one purge removed.
 * @param item - the purged item.
 * @param report - the purge's report.
 * @returns the line.
 */
function purgeLine(item: TrashItem, report: PurgeReport): string {
  const kept = report.attachmentsKept === 0 ? '' : ` Kept ${plural(report.attachmentsKept, 'attachment')} another chat still uses.`
  return `Deleted ${item.kind} ${quoted(item.label)} forever, from: ${report.removedFrom.join(', ')}.${kept}\n`
}

/**
 * The lines that state what is left in the operational logs.
 * @param clearLogs - whether the person asked to clear them.
 * @param report - the report of the purge that cleared them, when asked.
 * @returns the lines.
 */
function logLines(clearLogs: boolean, report: PurgeReport): string {
  const residue = `Fragments may remain in the operational logs for up to ${String(PURGE_RESIDUE_MAX_DAYS)} days; delorun logs --clear removes them now.\n`
  if (!clearLogs) return residue
  if (report.logs.cleared) return 'Every operational log of this home was cleared, so no fragment of the deleted items remains in them.\n'
  return `These operational logs could not be cleared:\n${report.logs.failures.map(failure => `  ${failure}`).join('\n')}\n${residue}`
}

/**
 * Run `delorun trash`.
 * @param args - the arguments after `trash`, without `--profile`.
 * @param io - the home, the output, the question, the exclusion and the clock.
 * @returns the exit code.
 * @throws {CliError} for a wrong command line, a running home process, a declined purge, a workspace restore or a refused item.
 */
export async function runTrash(args: readonly string[], io: TrashIo): Promise<ExitCode> {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: { 'json': { type: 'boolean' }, 'clear-logs': { type: 'boolean' } }, strict: true, allowPositionals: true })
  } catch (error: unknown) {
    throw parseFailure('trash', error)
  }
  const [action, id, ...extra] = parsed.positionals
  const wants = (count: number): void => {
    if ((count === 1 ? id === undefined : id !== undefined) || extra.length > 0) throw new CliError(EXIT.usage, `${TRASH_USAGE}\n${helpPointer('trash')}`)
  }
  const trash = homeTrash(io.home)
  if (action === 'list') {
    wants(0)
    const items = await trash.list(io.now())
    const damaged = await trash.damaged()
    if (parsed.values.json === true) {
      io.stdout(`${JSON.stringify({
        retentionDays: TRASH_RETENTION_DAYS,
        items: items.map(({ id: itemId, kind, label, deletedAt, expiresAt, sessionIds, workspaceIds }) => ({ id: itemId, kind, label, deletedAt, expiresAt, sessionIds, workspaceIds })),
        damaged,
      })}\n`)
      return EXIT.ok
    }
    io.stdout(`${items.length === 0
      ? `The trash is empty. Deleted chats and workspaces stay here for ${String(TRASH_RETENTION_DAYS)} days.\n`
      : `${items.map(item => itemLine(item, io.now())).join('\n')}\n`}${damagedLines(damaged)}`)
    return EXIT.ok
  }
  if (action !== 'restore' && action !== 'purge' && action !== 'empty') throw new CliError(EXIT.usage, `${TRASH_USAGE}\n${helpPointer('trash')}`)
  wants(action === 'empty' ? 0 : 1)
  try {
    return await io.exclusive(async () => {
      await trash.settle()
      if (action === 'restore') return restore(trash, id!, io)
      return purge(trash, action === 'empty' ? undefined : id!, parsed.values['clear-logs'] === true, io)
    })
  } catch (error: unknown) {
    if (error instanceof TrashError) throw new CliError(EXIT.failed, `delorun trash ${action}: ${error.message}`)
    throw error
  }
}

/**
 * Restore one chat item.
 * @param trash - the service.
 * @param id - the item.
 * @param io - the output.
 * @returns the exit code.
 * @throws {CliError} for a workspace item, which the studio restores.
 */
async function restore(trash: TrashService, id: string, io: TrashIo): Promise<ExitCode> {
  const found = (await trash.list(io.now())).find(item => item.id === id)
  if (found !== undefined && (found.kind === 'workspace' || found.registration !== undefined)) {
    throw new CliError(EXIT.failed, `delorun trash restore: ${quoted(found.label)} is a workspace, and a restore registers it again in the workspace list the home process owns; restore it from the Trash section in the studio's Settings`)
  }
  const item = await trash.restore(id)
  io.stdout(`Restored chat ${quoted(item.label)}. A chat the studio archived for the delete stays archived until you unarchive it.\n`)
  return EXIT.ok
}

/**
 * Delete one item, or every item, forever after the person says yes. The
 * operational logs are cleared, when asked, by the last purge, so they hold no
 * record of an earlier one.
 * @param trash - the service.
 * @param id - the item, or `undefined` to empty the trash.
 * @param clearLogs - whether to clear every operational log.
 * @param io - the output and the question.
 * @returns the exit code.
 * @throws {CliError} when the person does not say yes.
 * @throws {TrashError} `TRASH_ITEM_NOT_FOUND` for an id the trash does not hold.
 */
async function purge(trash: TrashService, id: string | undefined, clearLogs: boolean, io: TrashIo): Promise<ExitCode> {
  const listed = await trash.list(io.now())
  const items = id === undefined ? listed : listed.filter(item => item.id === id)
  if (id !== undefined && items.length === 0) throw new TrashError('TRASH_ITEM_NOT_FOUND', `no trash item carries the id "${id}"`)
  if (items.length === 0) {
    io.stdout('The trash is empty.\n')
    return EXIT.ok
  }
  const what = id === undefined ? `every item in the trash (${String(items.length)})` : `${items[0]!.kind} ${quoted(items[0]!.label)}`
  const logs = clearLogs ? ' Every operational log of this home is cleared too, not only this deletion\'s records.' : ''
  const answer = await io.ask(`Delete ${what} forever? It is removed from every store Delorun keeps on this computer and cannot be restored.${logs} [y/N] `)
  if (!isYes(answer)) throw new CliError(EXIT.failed, `delorun trash ${id === undefined ? 'empty' : 'purge'}: nothing was deleted`)
  let last: PurgeReport | undefined
  for (const [index, item] of items.entries()) {
    last = await trash.purge(item.id, { clearLogs: clearLogs && index === items.length - 1 })
    io.stdout(purgeLine(item, last))
  }
  io.stdout(logLines(clearLogs, last!))
  return EXIT.ok
}
