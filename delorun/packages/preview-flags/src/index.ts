/**
 * @delorun/preview-flags: Delorun's preview flags. A plugin declares a studio feature that is not ready for everyone
 * (`ctx.previewFlags.declare`, as an effect), the profile row `delorun-preview-flags` turns it on (`config.flags`), and
 * the Host (`ctx.previewFlags.isOn`), the studio ({@link PREVIEW_FLAG_ROUTES}, `usePreviewFlag`) and `delorun preview`
 * read the same state. A preview flag changes studio UI only; the package README states the rule.
 *
 * The row checks its `flags` when it loads, against the flags the packages of the profile's rows list in their
 * manifests ([manifest](./manifest.ts)): a flag no package lists stops the row with a message that names it and the
 * known flags, and a flag whose declaring plugin is off is logged as a warning.
 *
 * @module @delorun/preview-flags
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readProfileManifest, resolveBundleDir, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { packageOf, readFlagIndex, rowPackages, type FlagIndex } from './manifest.ts'
import { createPreviewFlags, type PreviewFlags } from './registry.ts'
import { PREVIEW_FLAG_ROUTES, type PreviewFlagsAnswer } from './wire.ts'

export { isPreviewFlagId, knownList, PREVIEW_FLAG_ID, previewFlagId } from './flags.ts'
export type { BooleanPreviewFlag, PreviewFlagCopy, PreviewFlagDeclaration, PreviewFlagId, PreviewFlagKind } from './flags.ts'
export { assertFlagsIndexed, listedFlags, packageOf, readFlagIndex, resolvePackageDir, rowPackages } from './manifest.ts'
export type { FlagIndex, FlagIndexProblem, FlagPackage } from './manifest.ts'
export { createPreviewFlags } from './registry.ts'
export type { CreatedPreviewFlags, PreviewFlags, PreviewFlagsSource } from './registry.ts'
export { PREVIEW_FLAG_ROUTES, PreviewFlagsAnswer, PreviewFlagView } from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delorun's preview flags; present while the `delorun-preview-flags` row is mounted. */
    previewFlags: PreviewFlags
  }
}

/** The principal kind of an approved reach device, which `@delorun/home-auth` names `REACH_DEVICE`. */
const REACH_DEVICE_KIND = 'reach-device'

/**
 * The `admitPeer` of the read route: an approved reach device, whether or not its page is unlocked. The owner's Peer never reaches it.
 * @param _request - the request, unused.
 * @param peer - the Peer.
 * @param peer.principal - the Peer's principal.
 * @param peer.principal.kind - the principal's kind.
 * @returns whether the Peer is an approved reach device.
 */
function admitReachDevice(_request: unknown, peer: { readonly principal: { readonly kind: string } }): boolean {
  return peer.principal.kind === REACH_DEVICE_KIND
}

/** The plugin's name in logs. */
export const name = 'delorun-preview-flags'

/** The row's id in `@delorun/bundle-studio`'s patch, which `delorun preview` writes in the profile's own patch. */
export const PREVIEW_FLAGS_ROW_ID = 'delorun-preview-flags'

/** Required services: the Connection for the read route. */
export const inject = ['connection']

/** The row's configuration. */
export interface Config {
  /** The flags the profile sets, by id; a flag that is absent is off. */
  flags: Record<string, boolean>
}

/** The configuration schema. */
export const Config = z.object({
  flags: z.dict(z.boolean())
    .description('The preview flags this profile turns on, by flag id, such as `onboarding.previewSteps: true`. Each must be a flag a plugin of the profile declares, or the row does not load. `delorun preview on <flag>` and `off <flag>` write it.')
    .default({}),
})

/** The part of the Loader the row reads: each row's module name and whether it is disabled. */
interface RowStates {
  entries(): Iterable<{ readonly options: { readonly name?: unknown }, readonly disabled: boolean }>
}

/**
 * The files a row's package is resolved from, as the Loader resolves a bundle's rows: the installation, the profile,
 * and each of the profile's bundles, the ones it started with and the ones its manifest lists now, which include a
 * bundle the plugin manager added while Delorun runs.
 * @param profile - the profile.
 * @param warn - reports a bundle whose directory cannot be resolved; the plugin manager reports that bundle's own error.
 * @returns the anchors, in resolution order.
 * @throws {Error} when the profile's manifest cannot be read.
 */
function resolutionAnchors(profile: ProfileContext, warn: (message: string) => void): string[] {
  const current = readProfileManifest('delorun', profile.dir).dsh?.profile?.bundles ?? []
  const bundles = [...new Set([...profile.startedBundles, ...current])].flatMap((bundle) => {
    try {
      return [join(resolveBundleDir('delorun', bundle, profile.installAnchor, profile.dir), 'package.json')]
    } catch (error) {
      warn(`${bundle} was not read for preview flags: ${(error as Error).message}`)
      return []
    }
  })
  return [profile.installAnchor, join(profile.dir, 'package.json'), ...bundles]
}

/**
 * Check the row's flags, provide `ctx.previewFlags` and serve the read route.
 * @param ctx - the plugin context with the Connection.
 * @param config - the row's configuration.
 * @throws {Error} when a configured flag is in no package's list, flags are configured in a tree without a profile, or the profile's manifest cannot be read.
 */
export function apply(ctx: Context, config: Config): void {
  const warn = (message: string): void => { ctx.logger.warn(`${name}: ${message}`) }
  const profile: ProfileContext | undefined = ctx.get('profileContext')
  const loader: RowStates | undefined = ctx.get('loader')
  const rows = (): { readonly name?: unknown, readonly disabled: boolean }[] => [...loader?.entries() ?? []].map(entry => ({ name: entry.options.name, disabled: entry.disabled }))
  const read = (from: ProfileContext): FlagIndex => {
    const index = readFlagIndex(rowPackages(rows().map(row => row.name), resolutionAnchors(from, warn)))
    for (const problem of index.problems) ctx.logger.error(`${name}: the preview flags of ${problem.package} were not read: ${problem.message}`)
    return index
  }
  const index: FlagIndex | undefined = profile === undefined ? undefined : read(profile)
  const { flags, notices } = createPreviewFlags({
    configured: config.flags,
    index,
    ...profile === undefined ? {} : { reindex: () => read(profile) },
    pluginOff: owner => !rows().some(row => packageOf(row.name) === owner && !row.disabled),
  })
  for (const notice of notices) ctx.logger.warn(notice)
  ctx.provide('previewFlags', flags)
  ctx.connection.fetch.register({
    path: PREVIEW_FLAG_ROUTES.list,
    methods: ['GET'],
    requestBody: 'buffered',
    // Flag ids, their words and whether each is on: no setting or data, so a signed-in device reads it as the computer does.
    admitPeer: admitReachDevice,
    fetch: () => Promise.resolve(new Response(JSON.stringify({ flags: [...flags.list()] } satisfies PreviewFlagsAnswer), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })),
  })
}
