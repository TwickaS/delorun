/**
 * @delorun/preview-flags: Delorun's preview flags. A plugin declares a studio feature that is not ready for everyone
 * (`ctx.previewFlags.declare`, as an effect), the profile row `delorun-preview-flags` turns it on (`config.flags`), and
 * the Host (`ctx.previewFlags.isOn`), the studio ({@link PREVIEW_FLAG_ROUTES}, `usePreviewFlag`) and `delorun preview`
 * read the same state. A preview flag changes studio UI only; the package README states the rule.
 *
 * The row checks its `flags` when it loads, against the flags the profile's bundles list in their manifests
 * ([manifest](./manifest.ts)): a flag no bundle lists stops the row with a message that names it and the known flags,
 * and a flag whose declaring row is off is logged as a warning.
 *
 * @module @delorun/preview-flags
 */
import type { Context } from '@deepseek-ai/cordis'
import { readProfileManifest, resolveBundleDir, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { admitApprovedDevice } from '@delorun/home-auth'
import { readFlagIndex, type FlagBundle, type FlagIndex } from './manifest.ts'
import { createPreviewFlags, type PreviewFlags } from './registry.ts'
import { PREVIEW_FLAG_ROUTES, type PreviewFlagsAnswer } from './wire.ts'

export { isPreviewFlagId, knownList, PREVIEW_FLAG_ID, previewFlagId } from './flags.ts'
export type { BooleanPreviewFlag, PreviewFlagCopy, PreviewFlagDeclaration, PreviewFlagId, PreviewFlagKind } from './flags.ts'
export { assertFlagsIndexed, listedFlags, readFlagIndex } from './manifest.ts'
export type { FlagBundle, FlagIndex, FlagIndexProblem, FlagOwner } from './manifest.ts'
export { createPreviewFlags } from './registry.ts'
export type { CreatedPreviewFlags, PreviewFlags, PreviewFlagsSource } from './registry.ts'
export { PREVIEW_FLAG_ROUTES, PreviewFlagsAnswer, PreviewFlagView } from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delorun's preview flags; present while the `delorun-preview-flags` row is mounted. */
    previewFlags: PreviewFlags
  }
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

/** The part of the Loader the row reads: each row's id and whether it is disabled. */
interface RowStates {
  entries(): Iterable<{ readonly options: { readonly id: string }, readonly disabled: boolean }>
}

/**
 * The profile's bundles, as the index reads them: the ones it started with and the ones its manifest lists now, which
 * include a bundle the plugin manager added while Delorun runs.
 * @param profile - the profile.
 * @param warn - reports a bundle whose directory cannot be resolved; the plugin manager reports that bundle's own error.
 * @returns each resolvable bundle's name and directory.
 * @throws {Error} when the profile's manifest cannot be read.
 */
function profileBundles(profile: ProfileContext, warn: (message: string) => void): FlagBundle[] {
  const current = readProfileManifest('delorun', profile.dir).dsh?.profile?.bundles ?? []
  return [...new Set([...profile.startedBundles, ...current])].flatMap((bundle) => {
    try {
      return [{ name: bundle, dir: resolveBundleDir('delorun', bundle, profile.installAnchor, profile.dir) }]
    } catch (error) {
      warn(`${bundle} was not read for preview flags: ${(error as Error).message}`)
      return []
    }
  })
}

/**
 * Check the row's flags, provide `ctx.previewFlags` and serve the read route.
 * @param ctx - the plugin context with the Connection.
 * @param config - the row's configuration.
 * @throws {Error} when a configured flag is in no bundle's list, flags are configured in a tree without a profile, or the profile's manifest cannot be read.
 */
export function apply(ctx: Context, config: Config): void {
  const warn = (message: string): void => { ctx.logger.warn(`${name}: ${message}`) }
  const profile: ProfileContext | undefined = ctx.get('profileContext')
  const read = (from: ProfileContext): FlagIndex => {
    const index = readFlagIndex(profileBundles(from, warn))
    for (const problem of index.problems) ctx.logger.error(`${name}: the preview flags of ${problem.bundle} were not read: ${problem.message}`)
    return index
  }
  const index: FlagIndex | undefined = profile === undefined ? undefined : read(profile)
  const loader: RowStates | undefined = ctx.get('loader')
  const { flags, notices } = createPreviewFlags({
    configured: config.flags,
    index,
    ...profile === undefined ? {} : { reindex: () => read(profile) },
    rowOff: rowId => ![...loader?.entries() ?? []].some(entry => entry.options.id === rowId && !entry.disabled),
  })
  for (const notice of notices) ctx.logger.warn(notice)
  ctx.provide('previewFlags', flags)
  ctx.connection.fetch.register({
    path: PREVIEW_FLAG_ROUTES.list,
    methods: ['GET'],
    requestBody: 'buffered',
    // Flag ids, their words and whether each is on: no setting or data, so a signed-in device reads it as the computer does.
    admitPeer: admitApprovedDevice(),
    fetch: () => Promise.resolve(new Response(JSON.stringify({ flags: [...flags.list()] } satisfies PreviewFlagsAnswer), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })),
  })
}
