/**
 * The home's data-format record (contract C1, `data-format.json` at the home root): which release's data formats last
 * started over this home. A start writes it before the Host opens data, and `delorun repair` compares it with the release
 * it would install, so an older program is never started over data a newer program wrote. A home made before the record
 * has none; readers then treat the home's data formats as unknown.
 *
 * @module @delo/update/home-data-format
 */
import { randomBytes } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HOME_DATA_FORMAT_FILE, HOME_DATA_FORMAT_SCHEMA, type DataFormats, type HomeDataFormat } from '@delo/contract-update-report'
import semver from 'semver'
import { z } from 'zod'
import { parseDataFormats, readDataFormats } from './data-formats.ts'

const homeDataFormatSchema = z.strictObject({
  schema: z.literal(HOME_DATA_FORMAT_SCHEMA),
  delo: z.string().min(1),
  dsh: z.string().min(1),
  formats: z.looseObject({}),
})

/**
 * Parse the record's text.
 * @param text - the file's text.
 * @returns the record.
 * @throws {Error} when the text is not a {@link HOME_DATA_FORMAT_SCHEMA} record.
 */
export function parseHomeDataFormat(text: string): HomeDataFormat {
  const parsed = homeDataFormatSchema.safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error(`not a ${HOME_DATA_FORMAT_SCHEMA} record: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
  return { schema: HOME_DATA_FORMAT_SCHEMA, delo: parsed.data.delo, dsh: parsed.data.dsh, formats: parseDataFormats(JSON.stringify(parsed.data.formats)) }
}

/**
 * Read the home's record.
 * @param home - the resolved Delo home.
 * @returns the record, or `undefined` when the file is missing, malformed or another schema: the home's data formats
 *   are then unknown, never equal to a release's.
 */
export async function readHomeDataFormat(home: string): Promise<HomeDataFormat | undefined> {
  try {
    return parseHomeDataFormat(await readFile(join(home, HOME_DATA_FORMAT_FILE), 'utf8'))
  } catch (_unreadable) {
    // Missing or malformed: the comparison states it as `unknown`.
    return undefined
  }
}

/**
 * Write the record whole at mode 0600: a temporary sibling, synced, renamed over the name.
 * @param home - the resolved Delo home.
 * @param record - the record.
 * @throws {Error} when the file cannot be written.
 */
export async function writeHomeDataFormat(home: string, record: HomeDataFormat): Promise<void> {
  const path = join(home, HOME_DATA_FORMAT_FILE)
  const temporary = join(home, `.${HOME_DATA_FORMAT_FILE}.tmp-${randomBytes(8).toString('hex')}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify(record, undefined, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** The facts of a release whose data formats are compared with the home's. */
export interface ReleaseHomeFacts {
  /** The release's DSH version. */
  readonly dsh: string
  /** Its `data-formats.json`, or `undefined` when missing or unreadable. */
  readonly formats: DataFormats | undefined
}

/**
 * How a release's data formats relate to the home's record.
 * - `same`: equal facts.
 * - `older`: the home's data is older than the release reads, so the release migrates or reads it.
 * - `newer`: a newer program wrote the home's data: a higher DSH version or a higher Delo record.
 * - `different`: the facts differ and neither side can be ordered.
 * - `unknown`: the home has no record, or the release's `data-formats.json` cannot be read.
 */
export type HomeDataRelation = 'same' | 'older' | 'newer' | 'different' | 'unknown'

/**
 * Relate a release to the home's record.
 * @param home - the home's record, or `undefined` for a home with none.
 * @param release - the release's DSH version and data formats.
 * @returns the relation; only `same` and `older` let the release start over the home's data.
 */
export function relateHomeData(home: HomeDataFormat | undefined, release: ReleaseHomeFacts): HomeDataRelation {
  if (home === undefined || release.formats === undefined) return 'unknown'
  const homeDsh = semver.valid(home.dsh)
  const releaseDsh = semver.valid(release.dsh)
  if (homeDsh === null || releaseDsh === null) return 'unknown'
  const names = new Set([...Object.keys(home.formats.deloRecords), ...Object.keys(release.formats.deloRecords)])
  let homeHigher = false
  let releaseHigher = false
  for (const name of names) {
    const written = home.formats.deloRecords[name]
    const read = release.formats.deloRecords[name]
    // A record the release does not know is newer than anything it reads; one the home never wrote is older.
    if (written !== undefined && (read === undefined || written > read)) homeHigher = true
    if (read !== undefined && (written === undefined || read > written)) releaseHigher = true
  }
  const order = semver.compare(homeDsh, releaseDsh)
  if (order > 0 || homeHigher) return 'newer'
  if (order < 0 || releaseHigher) return 'older'
  return home.formats.persistence === release.formats.persistence ? 'same' : 'different'
}

/** What {@link recordHomeDataFormat} did. */
export type RecordOutcome = 'written' | 'kept' | 'no-formats'

/**
 * Record the running release's data formats at a start, before the Host opens data. A record that already shows newer
 * or unordered data is kept: an older program started over newer data must not hide that newer data exists.
 * @param request - the home, the running release's directory, its Delo and DSH versions.
 * @returns `written`; `kept` when the existing record is newer or unordered; `no-formats` when the running release has no
 *   readable `data-formats.json`, as a source run has none, so nothing is written.
 * @throws {Error} when the record cannot be written.
 */
export async function recordHomeDataFormat(request: { readonly home: string, readonly runtimeDirectory: string, readonly delo: string, readonly dsh: string }): Promise<RecordOutcome> {
  const formats = await readDataFormats(request.runtimeDirectory)
  if (formats === undefined) return 'no-formats'
  const existing = await readHomeDataFormat(request.home)
  const relation = relateHomeData(existing, { dsh: request.dsh, formats })
  if (relation === 'newer' || relation === 'different') return 'kept'
  await writeHomeDataFormat(request.home, { schema: HOME_DATA_FORMAT_SCHEMA, delo: request.delo, dsh: request.dsh, formats })
  return 'written'
}
