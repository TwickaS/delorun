/**
 * What the studio's setup routes do ([routes](./routes.ts) decides who may ask): write the profile's setup as a signed
 * file, read a file and plan its import, and apply a planned import. The work is `@delorun/changes/setup-transfer`'s,
 * the same functions `delorun setup export` and `delorun setup import` call, so the studio meets every check the
 * command meets: the file's validation, the policy of what a setup carries, and the plugin requests with the review of
 * a plugin's code.
 *
 * An inspected file is held in memory under a random token until it is applied, replaced by the next file, or ten
 * minutes pass; applying consumes it. The token names the held file, so the apply request carries no file and cannot
 * apply anything the person was not shown.
 *
 * @module @delorun/plugin-changes/setup-actions
 */
import { randomBytes } from 'node:crypto'
import { ArchiveError, ArchiveImporter, DirectoryWorkspaceStore, exportSetupArchive, loadHomeKey, signManifest, type OpenedSetup } from '@delorun/archive'
import { readProtection, type AtComputer, type ChangesContext, type PluginOperation, type ReloadHost } from '@delorun/changes'
import { applySetupImport, collectSetup, planSetupImport, type SetupPlan } from '@delorun/changes/setup-transfer'
import { join } from 'node:path'
import type { SetupApplyView, SetupExportView, SetupInspectView } from './wire.ts'

/** The largest setup file the studio writes or reads, in bytes; a larger one is moved with the commands. */
export const MAX_SETUP_FILE_BYTES = 32 * 1024 * 1024

/** How long an inspected file waits to be applied. */
export const SETUP_HOLD_MS = 10 * 60 * 1000

/** A refusal the setup routes answer with its status and code. */
export class SetupRefusal extends Error {
  /** The HTTP status. */
  readonly status: number
  /** The stable code. */
  readonly code: string

  /**
   * @param status - the HTTP status.
   * @param code - the stable code.
   * @param message - the sentence the person reads.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SetupRefusal'
    this.status = status
    this.code = code
  }
}

/** One inspected file waiting to be applied. */
interface Held {
  readonly token: string
  readonly profile: string
  readonly opened: OpenedSetup
  readonly expires: number
}

/** The inspected files a Host holds: at most one. */
export class HeldSetups {
  #held: Held | undefined
  readonly #now: () => number

  /**
   * @param now - the clock in milliseconds; `Date.now` by default.
   */
  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /**
   * Hold a file, replacing the one held.
   * @param profile - the profile it was inspected for.
   * @param opened - the validated file.
   * @returns the token that applies it.
   */
  hold(profile: string, opened: OpenedSetup): string {
    const token = randomBytes(24).toString('base64url')
    this.#held = { token, profile, opened, expires: this.#now() + SETUP_HOLD_MS }
    return token
  }

  /**
   * Take the held file, which can be taken once.
   * @param profile - the profile applying it.
   * @param token - the token `hold` returned.
   * @returns the file.
   * @throws {SetupRefusal} `410 SETUP_EXPIRED` when the token names no file held now, or another profile's.
   */
  take(profile: string, token: string): OpenedSetup {
    const held = this.#held
    this.#held = undefined
    if (held === undefined || held.token !== token || held.profile !== profile || held.expires < this.#now()) {
      throw new SetupRefusal(410, 'SETUP_EXPIRED', 'This setup file is no longer waiting. Choose the file again.')
    }
    return held.opened
  }
}

/**
 * Write the profile's setup as a signed file.
 * @param ctx - the profile.
 * @param version - the Delorun version that writes the file.
 * @returns the file and what went in and was left out.
 * @throws {SetupRefusal} `413 SETUP_TOO_LARGE` for a file over {@link MAX_SETUP_FILE_BYTES}, `422` with the archive's code when the document breaks the schema; the changes errors the collection throws, such as `SETUP_REFUSED` for a credential in a settings row, propagate.
 */
export async function exportSetup(ctx: ChangesContext, version: string): Promise<SetupExportView> {
  const collected = await collectSetup(ctx)
  const key = (await loadHomeKey(ctx.home, { create: true }))!
  let bytes: Uint8Array
  try {
    bytes = exportSetupArchive({
      createdBy: version,
      origin: { homeKeyId: key.keyId, publicKey: key.publicKey },
      document: collected.document,
      files: collected.files,
      sign: manifest => signManifest(manifest, key.keyId, key.privateKey),
    })
  } catch (error) {
    if (error instanceof ArchiveError) throw new SetupRefusal(422, error.code, error.message)
    throw error
  }
  if (bytes.length > MAX_SETUP_FILE_BYTES) {
    throw new SetupRefusal(413, 'SETUP_TOO_LARGE', `This setup is larger than the ${String(MAX_SETUP_FILE_BYTES / 1024 / 1024)} MiB the studio writes. Write it with delorun setup export.`)
  }
  return {
    file: Buffer.from(bytes).toString('base64'),
    name: 'setup.delorun',
    plugins: collected.document.plugins.length,
    local: collected.document.plugins.filter(plugin => plugin.source === 'local').length,
    settings: collected.document.patch.length,
    leftOut: collected.leftOut,
    signedBy: key.keyId,
  }
}

/**
 * Validate a setup file and plan its import; nothing is written.
 * @param ctx - the profile.
 * @param file - the file, as base64.
 * @param held - where the validated file waits for its apply.
 * @returns who signed it and everything the import would change.
 * @throws {SetupRefusal} `413 SETUP_TOO_LARGE`, or `422` with the archive's code for a file that fails a check; `SETUP_REFUSED` from the planning propagates.
 */
export async function inspectSetup(ctx: ChangesContext, file: string, held: HeldSetups): Promise<SetupInspectView> {
  const bytes = new Uint8Array(Buffer.from(file, 'base64'))
  if (bytes.length === 0) throw new SetupRefusal(400, 'BAD_REQUEST', 'The file is empty.')
  if (bytes.length > MAX_SETUP_FILE_BYTES) throw new SetupRefusal(413, 'SETUP_TOO_LARGE', `A setup file larger than ${String(MAX_SETUP_FILE_BYTES / 1024 / 1024)} MiB is imported with delorun setup import.`)
  const ownKey = await loadHomeKey(ctx.home)
  let opened: OpenedSetup
  try {
    opened = new ArchiveImporter({
      stagingParent: join(ctx.home, 'archive', 'staging'),
      store: new DirectoryWorkspaceStore(join(ctx.home, 'archive', 'imported')),
      trustedPublicKeys: ownKey === undefined ? [] : [ownKey.publicKey],
    }).openSetup(bytes)
  } catch (error) {
    if (error instanceof ArchiveError) throw new SetupRefusal(422, error.code, error.message)
    throw error
  }
  const { plan } = await planSetupImport(ctx, opened.document)
  return view(held.hold(ctx.profile, opened), opened, plan, await readProtection(ctx.home))
}

/**
 * The inspection as the screen reads it.
 * @param token - the token that applies the file.
 * @param opened - the validated file.
 * @param plan - the import's plan.
 * @param protection - the Changes protection setting.
 * @returns the view.
 */
function view(token: string, opened: OpenedSetup, plan: SetupPlan, protection: 'on' | 'off'): SetupInspectView {
  return {
    token,
    signer: opened.state === 'verified'
      ? { state: 'verified', fingerprint: opened.signer.fingerprint }
      : { state: 'unverified', reason: opened.reason === 'absent' ? 'absent' : 'key-not-trusted', fingerprint: opened.signer.fingerprint },
    createdBy: opened.createdBy,
    exportedAt: opened.exportedAt,
    sourceProfile: opened.document.profile,
    install: plan.install.map(item => ({
      name: item.plugin.name,
      ...item.plugin.version === undefined ? {} : { version: item.plugin.version },
      kind: item.kind,
      source: item.plugin.source,
      ...item.from === undefined ? {} : { from: item.from },
    })),
    remove: plan.remove,
    keep: plan.keep,
    settings: plan.settings,
    endpoints: plan.endpoints,
    leftOut: plan.leftOut,
    keyNotes: plan.keyNotes,
    protection,
    changes: plan.changes,
  }
}

/** What applying a held file needs besides the token. */
export interface ApplyEnvironment {
  /** Proof that the person is at their computer. */
  readonly presence: AtComputer
  /** Reloads the running Host. */
  readonly reload: ReloadHost
  /** Upstream's plugin operation for the profile. */
  readonly run: PluginOperation
}

/**
 * Apply an inspected file.
 * @param ctx - the profile.
 * @param token - the token the inspection returned.
 * @param held - where the validated file waits.
 * @param environment - the person's presence, the reload and the plugin operation.
 * @returns what was done.
 * @throws {SetupRefusal} `410 SETUP_EXPIRED` for a token that names no file waiting; the changes errors of the application propagate.
 */
export async function applySetup(ctx: ChangesContext, token: string, held: HeldSetups, environment: ApplyEnvironment): Promise<SetupApplyView> {
  const opened = held.take(ctx.profile, token)
  const { plan } = await planSetupImport(ctx, opened.document)
  const result = await applySetupImport(ctx, opened.document, { ...environment, readFile: opened.readFile })
  return {
    savedVersion: result.savedVersion,
    removed: result.removed,
    installed: result.installed.map(item => ({ name: item.name, ...item.reviewChange === undefined ? {} : { reviewChange: item.reviewChange } })),
    settingsWritten: result.settingsWritten,
    keyNotes: plan.keyNotes,
    protection: await readProtection(ctx.home),
  }
}
