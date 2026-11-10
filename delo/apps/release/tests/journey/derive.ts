/**
 * Makes one of the journey's derived releases in a process of its own, so the archiving does not hold up the spec's
 * servers: `tsx derive.ts <base directory> <base version> <epoch> <scratch> <version> <change>`, where change names one
 * of {@link CHANGES}. It prints the directory holding the release's archive and file list.
 *
 * @module journey/derive
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deriveClosure, replaceInClosure, tamperedArchive, type BaseClosure, type ClosureChange } from './parts.ts'

/**
 * Release 3's change, made to the extracted closure as a release that raises one of Delo's own versioned records would
 * make it: the `delo_chat_states` storage unit under `storages/` at version 2, whose reader still reads version 1 and
 * which writes itself at version 2 when the plugin starts, and `data-formats.json` naming the record's new version, so
 * the report names the data change. Release 1 refuses a unit stamped 2, and its chat-states row is a Delo row whose
 * failure refuses the start, so after release 3 has run only a restore of the copy lets release 1 start again.
 * @param stage - the extracted closure.
 */
async function raiseChatStates(stage: string): Promise<void> {
  const plugin = 'app/node_modules/@delo/plugin-chat-states/lib/index.js'
  await replaceInClosure(stage, plugin, /name: (["'])delo_chat_states\1,(\s+)version: 1,/u, 'name: $1delo_chat_states$1,$2version: 2,$2compatibleVersions: [1],')
  // The migration: one record written and removed again, which stamps the unit with version 2.
  await replaceInClosure(stage, plugin, /(const domain = await ctx\.storageDomain\.open\(chatStatesDomain\);)/u, "$1 await domain.table('chats').put('delo-journey-migration', {}); await domain.table('chats').delete('delo-journey-migration');")
  const formats = JSON.parse(await readFile(join(stage, 'data-formats.json'), 'utf8')) as { deloRecords: Record<string, number> }
  if (formats.deloRecords['storage:delo_chat_states'] !== 1) throw new Error('the journey\'s fixture change no longer applies: data-formats.json does not name storage:delo_chat_states at version 1')
  formats.deloRecords['storage:delo_chat_states'] = 2
  await writeFile(join(stage, 'data-formats.json'), `${JSON.stringify(formats, undefined, 2)}\n`)
}

/**
 * The changes a derived release can make, by name.
 *
 * - `none`: the same closure under another version (release 2).
 * - `studio-without-index`: the studio's index removed, so the Host never answers the health check's request for it
 *   (release 2b).
 * - `chat-states-v2`: {@link raiseChatStates} (release 3).
 * - `tampered`: an honest closure whose archive then gets one byte of `data-formats.json` changed, while its signed file
 *   list describes the file before the change.
 */
export const CHANGES: Readonly<Record<string, ClosureChange | undefined>> = {
  'none': undefined,
  'studio-without-index': stage => rm(join(stage, 'app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html')),
  'chat-states-v2': raiseChatStates,
  'tampered': undefined,
}

/**
 * Make one release.
 * @param base - the base closure.
 * @param scratch - the run's directory.
 * @param version - the release's version.
 * @param change - the change's name.
 * @returns the directory holding the archive and file list.
 */
export async function derive(base: BaseClosure, scratch: string, version: string, change: string): Promise<string> {
  if (!(change in CHANGES)) throw new Error(`unknown change ${change}; use ${Object.keys(CHANGES).join(', ')}`)
  if (change !== 'tampered') return deriveClosure(base, scratch, version, CHANGES[change])
  const honest = await deriveClosure(base, scratch, version, undefined, join(scratch, `closure-${version}-honest`))
  return tamperedArchive(honest, version, 'data-formats.json', join(scratch, `closure-${version}`))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, baseVersion, epoch, scratch, version, change] = process.argv.slice(2)
  try {
    process.stdout.write(`${await derive({ directory: directory!, version: baseVersion!, epoch: Number(epoch) }, scratch!, version!, change!)}\n`)
  } catch (error) {
    process.stderr.write(`derive: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
