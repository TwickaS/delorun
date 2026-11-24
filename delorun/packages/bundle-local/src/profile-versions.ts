/**
 * The Host half of the Setup versions section: the profile history's versions listed, compared and saved, and the
 * switch to another version, served as routes under `/api/delorunVersions.*`. Everything is `@delorun/profile-safety`'s: the
 * listing, the save and the switch run over the one history the plugin manager and `delorun recover` use, and the switch
 * is the restore `delorun recover restore` runs, after saving the current setup in the same locked step.
 *
 * Reading (`list`, `changes`) answers any signed-in studio. Saving and switching answer only a request that arrived on
 * the loopback listener from the studio's own origin: any other request is answered `403` before its body is read, so a
 * reach device can look at versions and cannot change the profile (C14 "Tailnet membership").
 *
 * @module @delorun/bundle-local/profile-versions
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge and its `connection/request` event.
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
// Type-only: the `plugin-manager/before-record` event the history's admission runs through.
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { ProfileVersionId, VersionAdmission } from '@deepseek-ai/dsh-plugin-manager/history'
import { discardImportReviews } from '@delorun/plugin-changes'
import { gateByClass, REACH_DEVICE, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import {
  HOME_PATCH_COPY_FILENAME, isProfileSafetyError, listProfileVersions, openHistory, planRestore, ProfileHomePatch, saveProfileVersion, switchToVersion, UPDATE_REPORT_FILENAME,
  type RestorePlan,
} from '@delorun/profile-safety'
import { z } from 'zod'
import { PROFILE_VERSION_ROUTES, type VersionChanges, type VersionEntry } from './client/versions-api.ts'
import { fromStudioPage } from './studio-page.ts'

/** The plugin's name in the loader's diagnostics. */
export const name = 'delorun-profile-versions'

/** The refusals the routes add to the home's own. */
export type VersionsRefusal = 'BAD_REQUEST' | 'UNKNOWN_VERSION' | 'NO_PROFILE' | 'FOREIGN_ORIGIN' | 'SAVE_REFUSED' | 'SWITCH_REFUSED'

/** The HTTP status of each refusal. */
export const VERSIONS_REFUSAL_STATUS: Readonly<Record<VersionsRefusal, number>> = {
  BAD_REQUEST: 400,
  UNKNOWN_VERSION: 404,
  NO_PROFILE: 404,
  FOREIGN_ORIGIN: 403,
  SAVE_REFUSED: 422,
  SWITCH_REFUSED: 422,
}

/** The largest request body a route reads, in bytes. */
export const MAX_VERSIONS_REQUEST_BYTES = 4096

/** What the routes tell a reach device that asks to save or switch. */
const ACTION = 'Saving or switching a setup version'

/** Where the profile lives and how its history admits a version. */
export interface VersionsWhere {
  /** The profile's name. */
  readonly profile: string
  /** The profile directory. */
  readonly profileDir: string
  /** The Delorun home. */
  readonly homeDir: string
  /** The history's admission, such as the secret-field check. */
  readonly admit?: VersionAdmission
}

/** A refusal the routes answer with its code. */
export class VersionsError extends Error {
  readonly code: VersionsRefusal

  /**
   * @param code - the refusal.
   * @param message - the sentence the person reads.
   * @param options - the cause, when one exists.
   */
  constructor(code: VersionsRefusal, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = 'VersionsError'
  }
}

/**
 * The comparison of a restore plan in the words the section shows.
 * @param plan - the history's plan for a version.
 * @returns the changes; `same` when switching would write nothing.
 */
export function changesOf(plan: RestorePlan): VersionChanges {
  const homePatchChanged = plan.homePatchWritten
  const disabled = plan.disabled.map(plugin => ({ name: plugin.name, message: plugin.message }))
  const same = plan.writes.every(name => name === HOME_PATCH_COPY_FILENAME || name === UPDATE_REPORT_FILENAME) && !homePatchChanged
  return {
    plugins: plan.changes.plugins.map(plugin => ({ name: plugin.name, ...plugin.from === undefined ? {} : { from: plugin.from }, ...plugin.to === undefined ? {} : { to: plugin.to } })),
    bundles: plan.bundles.map(bundle => ({ name: bundle.name, selected: bundle.selected })),
    exemptions: plan.changes.exemptions.map(exemption => ({ axis: exemption.axis, key: exemption.key, version: exemption.version, change: exemption.change })),
    builds: plan.changes.builds.map(build => ({ key: build.key, ...build.from === undefined ? {} : { from: build.from }, ...build.to === undefined ? {} : { to: build.to } })),
    patchChanged: plan.patchChanged,
    homePatchChanged,
    lockfileChanged: plan.lockfileChanged,
    disabled,
    same,
  }
}

/** The versions service the routes call. */
export class ProfileVersions {
  private readonly where: () => VersionsWhere | undefined
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param where - reads the profile's location when a call needs it; undefined while the Host has no profile.
   */
  constructor(where: () => VersionsWhere | undefined) {
    this.where = where
  }

  /**
   * The profile's versions, newest first.
   * @returns the listing, or `problem` when the history cannot be read.
   */
  async list(): Promise<{ versions: readonly VersionEntry[], unsaved: boolean, problem?: string }> {
    const where = this.located()
    try {
      const listing = await listProfileVersions({ profileDir: where.profileDir, homeDir: where.homeDir })
      return { versions: listing.versions, unsaved: listing.unsaved }
    } catch (_unreadable) {
      // The history's own message can quote git's output and paths; the section shows one sentence.
      return { versions: [], unsaved: false, problem: 'The version history could not be read. Check that git is installed (delorun doctor).' }
    }
  }

  /**
   * What switching to a version would change.
   * @param id - the version's id.
   * @returns the comparison with the profile now.
   * @throws {VersionsError} `BAD_REQUEST` for an id that is not a version id, `UNKNOWN_VERSION` when the history lacks it.
   */
  async changes(id: string): Promise<VersionChanges> {
    const where = this.located()
    const version = await this.known(id, where)
    return changesOf(await planRestore({ profileDir: where.profileDir, homeDir: where.homeDir, version }))
  }

  /**
   * Save the setup as a version.
   * @param name - the person's name for it, optional.
   * @returns the version and whether it is new.
   * @throws {VersionsError} `SAVE_REFUSED` with the history's reason, such as a secret value in a settings file.
   */
  save(name: string | undefined): Promise<{ id: string, created: boolean }> {
    const where = this.located()
    return this.serial(async () => {
      try {
        return await saveProfileVersion({ profileDir: where.profileDir, homeDir: where.homeDir, ...name === undefined ? {} : { name }, ...where.admit === undefined ? {} : { admit: where.admit } })
      } catch (error) {
        throw refused('SAVE_REFUSED', error)
      }
    })
  }

  /**
   * Switch to a version, saving the setup first.
   * @param id - the version's id.
   * @returns the version saved before the switch, what changed, and that a restart is needed when anything did.
   * @throws {VersionsError} `BAD_REQUEST`, `UNKNOWN_VERSION`, or `SWITCH_REFUSED` with the reason; nothing has changed then.
   */
  switch(id: string): Promise<{ saved?: string, changes: VersionChanges, restartNeeded: boolean }> {
    const where = this.located()
    return this.serial(async () => {
      const version = await this.known(id, where)
      try {
        const report = await switchToVersion({
          profile: where.profile, profileDir: where.profileDir, homeDir: where.homeDir, version, ...where.admit === undefined ? {} : { admit: where.admit },
        })
        const changes = changesOf(report.plan!)
        // Going back to the version saved before a setup import takes away the code reviews that import created.
        await discardImportReviews({ home: where.homeDir, profile: where.profile, profileDir: where.profileDir }, version)
        return { ...report.saved === undefined ? {} : { saved: report.saved }, changes, restartNeeded: !changes.same }
      } catch (error) {
        throw refused('SWITCH_REFUSED', error)
      }
    })
  }

  private located(): VersionsWhere {
    const where = this.where()
    if (where === undefined) throw new VersionsError('NO_PROFILE', 'This studio runs without a profile, so it has no setup versions.')
    return where
  }

  private async known(id: string, where: VersionsWhere): Promise<ProfileVersionId> {
    if (!/^[0-9a-f]{40}$/.test(id)) throw new VersionsError('BAD_REQUEST', 'The request must name a version by its id.')
    const found = await openHistory({ profileDir: where.profileDir }).version(id as ProfileVersionId).catch((error: unknown) => {
      throw new VersionsError('SWITCH_REFUSED', 'The version history could not be read. Check that git is installed (delorun doctor).', { cause: error })
    })
    if (found === undefined) throw new VersionsError('UNKNOWN_VERSION', 'That version is not in this profile\'s history.')
    return found.id
  }

  /** Run writes one at a time, so a second click waits for the first. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    return next
  }
}

/**
 * A refusal for a failed save or switch, carrying the history's own reason.
 * @param code - the refusal.
 * @param error - what the history threw.
 * @returns the refusal.
 */
function refused(code: 'SAVE_REFUSED' | 'SWITCH_REFUSED', error: unknown): VersionsError {
  if (error instanceof VersionsError) return error
  const reason = isProfileSafetyError(error) ? error.detail : error instanceof Error ? error.message : String(error)
  return new VersionsError(code, reason, { cause: error })
}

const SaveBody = z.strictObject({ name: z.string().max(200).optional() })
const SwitchBody = z.strictObject({ version: z.string().min(1).max(64) })

/**
 * The JSON response of a status and a body, never cached.
 * @param status - the HTTP status.
 * @param body - the body.
 * @returns the response.
 */
function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Parse a bounded JSON body against a schema.
 * @param request - the request.
 * @param schema - the message.
 * @returns the message, or undefined for a body that is too long, not JSON or not the message.
 */
async function parsed<T>(request: Request, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_VERSIONS_REQUEST_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // The parser's message quotes the body; the request is only refused.
    return undefined
  }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

/**
 * Run a service call and answer it, turning a {@link VersionsError} into its refusal.
 * @param call - the call.
 * @returns the response.
 * @throws whatever else the call throws, which upstream's connection answers as a failure.
 */
async function run(call: () => Promise<object>): Promise<Response> {
  try {
    return json(200, await call())
  } catch (error) {
    if (error instanceof VersionsError) return json(VERSIONS_REFUSAL_STATUS[error.code], { error: error.code, message: error.message })
    throw error
  }
}

/**
 * Register the routes on a context that holds the Connection. The arrival and origin checks run on the Connection's
 * `connection/request` hook, before the route reads anything.
 * @param ctx - the context, whose disposal removes the routes and the hook.
 * @param service - the versions service the routes call.
 */
export function registerVersionRoutes(ctx: Context, service: ProfileVersions): void {
  const writes: ReadonlySet<string> = new Set([PROFILE_VERSION_ROUTES.save, PROFILE_VERSION_ROUTES.switch])
  ctx.on('connection/request', async (request, response, next) => {
    if (writes.has(routedPathname(request.url))) {
      const homeAuth = ctx.get('homeAuth')
      if (!requireComputerOrDevice(request, response, homeAuth, ACTION)) return
      if (!fromStudioPage(request, homeAuth?.arrivalOf(request).listener === 'loopback')) {
        response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: 'FOREIGN_ORIGIN', message: `${ACTION} must come from the studio's own page.` }))
        return
      }
    }
    await next()
  })
  ctx.connection.fetch.register({
    path: PROFILE_VERSION_ROUTES.list, methods: ['GET'], requestBody: 'buffered',
    admitPeer: admitsReachReader,
    fetch: () => run(() => service.list()),
  })
  ctx.connection.fetch.register({
    path: PROFILE_VERSION_ROUTES.changes, methods: ['GET'], requestBody: 'buffered',
    admitPeer: admitsReachReader,
    fetch: (request) => run(async () => ({ changes: await service.changes(new URL(request.url).searchParams.get('version') ?? '') })),
  })
  ctx.connection.fetch.register({
    path: PROFILE_VERSION_ROUTES.save, methods: ['POST'], requestBody: 'buffered',
    ...gateByClass(() => ctx.get('homeAuth'), async (request) => {
      const body = await parsed(request, SaveBody)
      if (body === undefined) return json(400, { error: 'BAD_REQUEST', message: 'The request must be JSON with an optional name.' })
      return run(() => service.save(body.name))
    }, { row: 'route:bundle-local/src/profile-versions.ts#PROFILE_VERSION_ROUTES.save', action: 'bundle-local/profile-save', legacy: { renews: true } }),
  })
  ctx.connection.fetch.register({
    path: PROFILE_VERSION_ROUTES.switch, methods: ['POST'], requestBody: 'buffered',
    ...gateByClass(() => ctx.get('homeAuth'), async (request) => {
      const body = await parsed(request, SwitchBody)
      if (body === undefined) return json(400, { error: 'BAD_REQUEST', message: 'The request must be JSON with the version.' })
      return run(() => service.switch(body.version))
    }, { row: 'route:bundle-local/src/profile-versions.ts#PROFILE_VERSION_ROUTES.switch', action: 'bundle-local/profile-switch', legacy: { renews: true } }),
  })
}

/** Admits a signed-in reach device to the two read-only routes; saving and switching stay with the owner at the computer. */
const admitsReachReader: NonNullable<ConnectionFetchRoute['admitPeer']> = (_request, peer) => peer.principal.kind === REACH_DEVICE

/**
 * Where the running profile and its history are.
 * @param ctx - the scope that holds the profile.
 * @returns the profile's location with the history's admission, or `undefined` in a Host started without a profile.
 */
function versionsWhere(ctx: Context): VersionsWhere | undefined {
  const profile = ctx.get('profileContext')
  if (profile === undefined) return undefined
  return {
    profile: profile.name,
    profileDir: profile.dir,
    homeDir: profile.home,
    admit: files => ctx.bail('plugin-manager/before-record', files),
  }
}

/**
 * Provide the home patch's half of a profile version, so the plugin manager's versions cover both patch layers: the
 * manager mirrors the home patch into the profile before it saves a version, and writes a version's home patch back
 * when it restores one. The history is the manager's own, opened over the files it tracks.
 * @param ctx - the row's scope.
 */
function provideHomePatch(ctx: Context): void {
  // The profile is read when a call needs it, so a Host that provides it after this row still gets the service.
  const service = new ProfileHomePatch(() => {
    const profile = ctx.get('profileContext')
    if (profile === undefined) return undefined
    return {
      profileDir: profile.dir,
      homeDir: profile.home,
      history: () => openHistory({ profileDir: profile.dir }),
    }
  })
  ctx.effect(() => ctx.provide('profileHomePatch', service), 'delorun-profile-versions: home patch')
}

/**
 * Mount the routes once the Connection is up. The versions come from the history that `delorun recover` and the plugin
 * manager share, so the row keeps no store of its own.
 * @param ctx - the row's scope.
 */
export function apply(ctx: Context): void {
  provideHomePatch(ctx)
  ctx.inject(['connection'], (scope) => {
    registerVersionRoutes(scope, new ProfileVersions(() => versionsWhere(scope)))
  })
}
