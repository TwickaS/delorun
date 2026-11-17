/**
 * The optional plugin packs of the running release, as the composition tells them from Delorun's own bundles: the names
 * that the release's stored packs file lists, read and verified again under the anchored trusted root on every start.
 * A pack bundle loads from its Changes review copy, not from the runtime's packages, so the composition does not hold its
 * rows to the rules for Delorun's own rows ([compose](./compose.ts)), which never counts a runtime bundle's name as a pack.
 *
 * @module @delorun/cli/release-packs
 */
import { DELORUN_HOME_ENV } from '@delorun/contract-home-layout'
import { hostPacksEnvironment } from '@delorun/plugin-packs/environment'
import { readStoredPacks } from '@delorun/runtime-store'
import { CliError, EXIT } from './exit.ts'

/** What the packs are read for: the Delorun home and the launch environment, which names the running release and its roots. */
export interface ReleasePacksRequest {
  /** The prepared Delorun home. */
  readonly home: string
  /** The launch environment. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * Reads the names of the running release's verified packs.
 * @param request - the home and the launch environment.
 * @returns the pack bundle names; empty when the process runs from no installed release or the release stores no packs file.
 * @throws {CliError} when the stored packs file does not verify.
 */
export type ReleasePacks = (request: ReleasePacksRequest) => Promise<ReadonlySet<string>>

/** No packs: a source checkout's composition, and specs that install none. */
export const NO_RELEASE_PACKS: ReleasePacks = () => Promise.resolve(new Set())

/**
 * The packs of the running installation: the release `DELORUN_VERSION` names, verified under the launcher's roots.
 * Without an installed release, its roots or a supported platform there are none, so every `@delorun/` bundle is held to
 * the rules for Delorun's own.
 * @param request - the home and the launch environment.
 * @returns the names the verified packs file lists.
 * @throws {CliError} when the release's manifest or stored packs file does not verify.
 */
export const runningReleasePacks: ReleasePacks = async ({ home, env }) => {
  const environment = await hostPacksEnvironment({ ...env, [DELORUN_HOME_ENV]: home })
  if ('unsupported' in environment) return new Set()
  try {
    return new Set((await readStoredPacks(await environment.release()))?.packs.map(pack => pack.name))
  } catch (error) {
    throw new CliError(EXIT.failed, `delorun: the running release's plugin packs file could not be verified (${error instanceof Error ? error.message : String(error)}), so Delorun cannot tell its optional packs from its own bundles and did not start. To fix it, run: delorun recover packs`)
  }
}
