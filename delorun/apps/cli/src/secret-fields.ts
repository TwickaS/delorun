/**
 * Contract C1 keeps every secret out of patch files. A plugin field whose Config schema has the role `secret`, such as
 * the DeepSeek API key fields of upstream's web search plugins, holds a credential, and the profile's patch files are
 * saved in git by the profile history; Delorun keeps such a value in upstream's credentials file under the home instead.
 * Over a booted Host this module:
 *
 * - refuses a configuration edit, from the studio's Settings, the agent's `configure` action, the import of an old
 *   `settings.yaml` or any other caller of upstream's configuration editor, that would save a value for a secret-role
 *   field into the profile patch, before the file is written (`config-editor/before-save`);
 * - refuses to save a profile history version whose patch holds such a value (`plugin-manager/before-record`), so an
 *   edit made by hand never enters the history either;
 * - moves such a value that a patch already holds into the credentials store at start, wherever the plugin names a
 *   stored credential in a `credential-ref` field beside it, and otherwise names the field on every start until it is
 *   gone, while the history saves no version.
 *
 * The listeners are registered before the Loader mounts its first row, so edits a plugin makes while it starts are
 * guarded too. Only rows of loaded plugins are checked, because only a loaded plugin's schema says which fields are
 * secret.
 *
 * @module @delorun/cli/secret-fields
 */
import { existsSync, readFileSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PROFILE_LOCK_WAIT_MS, withProfileWriteLock } from '@delorun/changes'
import type {} from '@deepseek-ai/dsh-config-editor'
import { credentialRef, isCredentialRefName, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import {
  describeSecretField, expressionOf, HOME_PATCH_COPY_FILENAME, findSecretValues, secretFieldAdmission, secretFieldRemedy, secretFieldsSet,
  type ConfigSchemasOf, type SecretReference, type SecretValueFound,
} from '@delorun/profile-safety'
import { isSeq, parse, parseDocument, type Document } from 'yaml'
import { profileDirectory } from './profile.ts'
import { JS_TAG } from '@delorun/setup-apply'
import { CREDENTIALS_FILENAME } from './setup/writes.ts'

/** The patch file of a profile and of the home. */
const PATCH_FILENAME = 'cordis.patch.yml'

/** What settling a start's patch files did, as lines the person reads; no line holds a value. */
export interface SecretSettlement {
  /** Each value moved into the credentials store, or removed because the store already holds it. */
  readonly moved: readonly string[]
  /** Each value left in place, with why and how to move it; printed on every start while it stays. */
  readonly notices: readonly string[]
}

/**
 * The Config schemas of a booted Host's Loader rows, read when asked, so a plugin loaded or replaced later counts.
 * @param ctx - the booted profile's root context.
 * @returns the lookup by row id, or by plugin name for a row without one.
 */
export function configSchemasOf(ctx: Context): ConfigSchemasOf {
  return (row) => {
    const loader = ctx.get('loader')
    if (loader === undefined) return []
    return [...loader.entries()]
      .filter(entry => row.id === undefined ? entry.options.name === row.name : entry.options.id === row.id)
      .flatMap((entry) => {
        const schema: unknown = entry.fiber?.runtime?.Config
        return schema === undefined ? [] : [schema]
      })
  }
}

/**
 * Refuse configuration edits and profile history versions that would save a value for a secret-role field, for as long
 * as the Host runs: both listeners are effects of `ctx`. Register them before the Loader mounts its first row.
 * @param ctx - the profile's root context.
 * @param schemas - its Config schemas ({@link configSchemasOf}).
 */
export function guardSecretFields(ctx: Context, schemas: ConfigSchemasOf): void {
  ctx.on('config-editor/before-save', ({ entry, config }) => {
    const fields = secretFieldsSet(config, [entry.fiber?.runtime?.Config])
    if (fields.length === 0) return undefined
    const named = fields.map(field => describeSecretField(entry.options.id, field)).join(' and ')
    return `This change was not saved: it would write a value for ${named} into the profile's settings file, which the profile history saves in git. ${secretFieldRemedy(fields.every(field => field.references.length > 0))} If the settings file already holds the value, delete it there.`
  })
  ctx.on('plugin-manager/before-record', secretFieldAdmission(schemas))
}

/**
 * A credential name derived from a field's place, as a POSIX identifier.
 * @param entryId - the row's patch id or plugin name.
 * @param path - the field's path.
 * @returns e.g. `WEB_DEEPSEEK_API_APIKEY`.
 */
export function credentialNameFor(entryId: string, path: readonly string[]): string {
  const name = [entryId, ...path].join('_').toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '')
  return /^[A-Z_]/u.test(name) ? name : `KEY_${name}`
}

/** The most names {@link storeValue} tries for one value before it leaves the value in place. */
export const MAX_NAME_ATTEMPTS = 100

/**
 * The names the credentials file holds now and their values, read from the file itself rather than from a provider's
 * cached view, so a name another process stored a moment ago counts.
 * @param path - the credentials file.
 * @returns each stored name with its value; empty when the file is absent.
 * @throws {Error} when the file is not a credentials document.
 */
function storedNames(path: string): Map<string, unknown> {
  if (!existsSync(path)) return new Map()
  const document: unknown = parse(readFileSync(path, 'utf8'))
  const refs = typeof document === 'object' && document !== null ? Reflect.get(document, 'refs') : undefined
  return new Map(typeof refs === 'object' && refs !== null ? Object.entries(refs) : [])
}

/**
 * Move one value into the credentials store, or find that the store holds it already. A name the credentials file or
 * the environment gives another value is never written over. The caller holds the home-wide settle lock, so no other
 * start picks the same name between the check and the write.
 * @param credentials - the Host's credential provider, upstream's credentials writer.
 * @param file - the credentials file, read before each name is chosen.
 * @param entryId - the row's patch id or plugin name, which the new name derives from.
 * @param path - the field's path, which the new name derives from.
 * @param target - the value and the name its reference field gives now.
 * @returns the name the reference field names afterwards, and whether the file already held the value under the
 *   current name.
 * @throws {Error} when no free name is found in {@link MAX_NAME_ATTEMPTS} tries, or the store refuses the write.
 */
async function storeValue(credentials: CredentialProvider, file: string, entryId: string, path: readonly string[], target: MoveTarget): Promise<{ name: string; held: boolean }> {
  const stored = storedNames(file)
  if (target.current !== undefined && stored.get(target.current) === target.value) return { name: target.current, held: true }
  const base = credentialNameFor(entryId, path)
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? base : `${base}_${String(attempt)}`
    if (stored.has(name)) {
      if (stored.get(name) === target.value) return { name, held: false }
      continue
    }
    if (await credentials.resolve(credentialRef(name)) !== undefined) continue
    await credentials.set(credentialRef(name), target.value)
    return { name, held: false }
  }
  throw new Error(`no free credential name was found from ${base} to ${base}_${String(MAX_NAME_ATTEMPTS)}`)
}

/**
 * Flush a file and the directory that holds it to disk, so a patch rewritten afterwards never outlives the value it
 * points at. Directories cannot be opened for flushing on Windows, where only the file is flushed.
 * @param path - the file.
 */
async function flushToDisk(path: string): Promise<void> {
  for (const target of process.platform === 'win32' ? [path] : [path, dirname(path)]) {
    const handle = await open(target, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

/**
 * The YAML path of a config field, with an index for each step through a sequence.
 * @param document - the patch document.
 * @param location - the row config's YAML path.
 * @param path - the field's path inside the config.
 * @returns the document path.
 */
function documentPath(document: Document, location: readonly (string | number)[], path: readonly string[]): (string | number)[] {
  const result: (string | number)[] = [...location]
  for (const key of path) {
    result.push(isSeq(document.getIn(result, true)) ? Number(key) : key)
  }
  return result
}

/** A value that can be moved: its text, the reference field beside it, and the name that field gives now. */
interface MoveTarget {
  readonly value: string
  readonly reference: SecretReference
  readonly current: string | undefined
}

/**
 * Decide whether one value can be moved.
 * @param found - the place.
 * @returns what moving it needs, or why it stays.
 */
function moveTarget(found: SecretValueFound): MoveTarget | { readonly stays: string } {
  if (typeof found.value !== 'string') {
    return { stays: expressionOf(found.value) === undefined ? 'it is not text' : 'it is a `!!js` expression that does more than read an environment variable' }
  }
  if (found.reference === undefined) return { stays: 'the plugin has no credential field to name a stored key' }
  const named = found.reference.value ?? found.reference.default
  if (named === undefined) return { value: found.value, reference: found.reference, current: undefined }
  if (typeof named === 'string' && isCredentialRefName(named)) return { value: found.value, reference: found.reference, current: named }
  return { stays: `its credential field ${found.reference.field} does not hold a credential name` }
}

/**
 * Move the values for secret-role fields that one patch file holds into the credentials store, and rewrite the file
 * without them, keeping its comments and `!!js` expressions.
 * @param path - the patch file.
 * @param schemas - the Host's Config schemas.
 * @param credentials - the Host's credential provider, if it loads one.
 * @param credentialsFile - the credentials file it writes.
 * @returns what was moved and what stays.
 */
async function settleFile(path: string, schemas: ConfigSchemasOf, credentials: CredentialProvider | undefined, credentialsFile: string): Promise<SecretSettlement> {
  const text = readFileSync(path, 'utf8')
  const found = findSecretValues(path, text, schemas)
  const moved: string[] = []
  const notices: string[] = []
  if (found.length === 0) return { moved, notices }
  const document = parseDocument(text, { customTags: [JS_TAG] })
  for (const place of found) {
    const field = describeSecretField(place.entryId, place)
    const stays = (reason: string): void => {
      notices.push(`${path} holds a value for ${field}, which Delorun left in place because ${reason}. The profile history saves no new version until it is gone from the file. ${secretFieldRemedy(place.references.length > 0)}`)
    }
    const target = moveTarget(place)
    if ('stays' in target) {
      stays(target.stays)
      continue
    }
    if (credentials === undefined) {
      stays('the profile loads no credentials store')
      continue
    }
    try {
      const { name, held } = await storeValue(credentials, credentialsFile, place.entryId, place.path, target)
      document.deleteIn(documentPath(document, place.location, place.path))
      if (name !== target.current) document.setIn(documentPath(document, place.location, [...place.path.slice(0, -1), target.reference.field]), name)
      moved.push(held
        ? `${path}: removed the value of ${field}, because the credentials file already holds it as ${name}.`
        : `${path}: moved the value of ${field} into the credentials file as ${name}, and set ${target.reference.field} to ${name}.`)
    } catch (error) {
      stays(`storing it failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (moved.length === 0) return { moved, notices }
  if (existsSync(credentialsFile)) await flushToDisk(credentialsFile)
  await writeFileAtomic(path, String(document), { mode: 0o600 })
  return { moved, notices }
}

/**
 * Settle a start's patch files: move each value for a secret-role field that the profile patch or the home patch holds
 * into the credentials store through the Host's credential provider, wherever the plugin names a stored credential in a
 * `credential-ref` field beside it. A value the store already holds under the name that field gives, the schema's
 * default included, is only removed from the patch. Any other value is stored under a new name derived from its place,
 * never over a name that holds another value, and the reference field is set to it. A value that cannot be moved stays,
 * and a notice names it with the way to move it. The credentials file and its directory are flushed to disk before a
 * patch is rewritten. Both files are rewritten under the profile's writer lock and the home patch's, and the
 * profile's copy of the home patch, which an earlier snapshot may have written with a value in it, is replaced with a
 * copy of the home patch as it is now. The profile's lock is taken only when this process does not hold it already: a
 * caller that does, such as a start's own pre-start step or upstream's plugin management in the middle of a change,
 * would otherwise wait for itself until the wait expired, and the version that settles would be lost with it.
 * @param ctx - the booted profile's root context.
 * @param home - the Delorun home.
 * @param profile - the profile.
 * @param schemas - its Config schemas ({@link configSchemasOf}).
 * @param options - how long to wait for another process's hold of the profile lock, {@link PROFILE_LOCK_WAIT_MS} by default.
 * @returns what was moved and what stays; no line holds a value.
 */
export async function settleSecretValues(ctx: Context, home: string, profile: string, schemas: ConfigSchemasOf, options?: { readonly lockWaitMs?: number }): Promise<SecretSettlement> {
  const profileDir = profileDirectory(home, profile)
  const credentials = ctx.get('credentials')
  const homePatch = join(home, PATCH_FILENAME)
  const credentialsFile = join(home, CREDENTIALS_FILENAME)
  // The profile's writer lock, then the home patch's: every start that settles takes the second, so two profiles, or a
  // start and `delorun headless`, never choose a credential name or rewrite the home patch at the same time. The profile
  // lock is not taken again when this process holds it already, such as a start's own pre-start step or upstream's
  // plugin management in the middle of a change; waiting for it then expires against this very process and costs the
  // profile its history version for a change that did write the patch.
  return await withProfileWriteLock(profileDir, () => withFileLock(homePatch, async () => {
    const moved: string[] = []
    const notices: string[] = []
    for (const path of [join(profileDir, PATCH_FILENAME), homePatch]) {
      if (!existsSync(path)) continue
      const settled = await settleFile(path, schemas, credentials, credentialsFile)
      moved.push(...settled.moved)
      notices.push(...settled.notices)
    }
    // An earlier snapshot's copy of the home patch would keep every later version out of the history; it becomes a copy
    // of the home patch as it is now, as the next snapshot would write it.
    const copy = join(profileDir, HOME_PATCH_COPY_FILENAME)
    if (existsSync(copy) && findSecretValues(copy, readFileSync(copy, 'utf8'), schemas).length > 0) {
      if (existsSync(homePatch)) {
        await writeFileAtomic(copy, readFileSync(homePatch, 'utf8'), { mode: 0o600 })
        moved.push(`${copy}: replaced with a copy of ${homePatch} as it is now.`)
      } else {
        await rm(copy, { force: true })
        moved.push(`${copy}: removed, because ${homePatch} does not exist.`)
      }
    }
    return { moved, notices }
  }), { waitMs: options?.lockWaitMs ?? PROFILE_LOCK_WAIT_MS })
}

/**
 * Tell the person what settling did: each move on standard output, each value left in place on standard error, and both
 * in the log when there is one.
 * @param settlement - what settling did.
 * @param output - the command's output.
 * @param log - the home process's log, when the command keeps one.
 * @param log.info - writes an `info` record.
 * @param log.warn - writes a `warn` record.
 */
export function reportSecretSettlement(settlement: SecretSettlement, output: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void }, log?: { info(msg: string): void; warn(msg: string): void }): void {
  for (const line of settlement.moved) {
    output.stdout(`${line}\n`)
    log?.info(line)
  }
  for (const line of settlement.notices) {
    output.stderr(`${line}\n`)
    log?.warn(line)
  }
}
