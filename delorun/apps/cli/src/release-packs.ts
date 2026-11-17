/**
 * The optional plugin packs of the running release, as the composition tells them from Delorun's own bundles: the names
 * that the release's stored packs file lists, read and verified again under the anchored trusted root on every start,
 * each with the folder the release installs it in. The composition counts a bundle as a pack only when it loads from that
 * folder or from the Changes review copy approved from it ([compose](./compose.ts)); a runtime bundle's name never counts.
 *
 * @module @delorun/cli/release-packs
 */
import { join } from 'node:path'
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
 * Reads the running release's verified packs.
 * @param request - the home and the launch environment.
 * @returns each pack bundle's name and the folder the release installs it in, `packs/<release>/<name>/package`; empty when
 *   the process runs from no installed release or the release stores no packs file.
 * @throws {CliError} when the stored packs file does not verify.
 */
export type ReleasePacks = (request: ReleasePacksRequest) => Promise<ReadonlyMap<string, string>>

/** No packs: a source checkout's composition, and specs that install none. */
export const NO_RELEASE_PACKS: ReleasePacks = () => Promise.resolve(new Map())

/**
 * The packs of the running installation: the release `DELORUN_VERSION` names, verified under the launcher's roots.
 * Without an installed release, its roots or a supported platform there are none, so every `@delorun/` bundle is held to
 * the rules for Delorun's own.
 * @param request - the home and the launch environment.
 * @returns the names the verified packs file lists, each with its folder under the running release's packs.
 * @throws {CliError} when the release's manifest or stored packs file does not verify.
 */
export const runningReleasePacks: ReleasePacks = async ({ home, env }) => {
  const environment = await hostPacksEnvironment({ ...env, [DELORUN_HOME_ENV]: home })
  if ('unsupported' in environment) return new Map()
  try {
    const release = await environment.release()
    return new Map((await readStoredPacks(release))?.packs.map(pack => [pack.name, join(release.paths.pack(release.version, pack.name), 'package')]))
  } catch (error) {
    throw new CliError(EXIT.failed, `delorun: the running release's plugin packs file could not be verified (${error instanceof Error ? error.message : String(error)}), so Delorun cannot tell its optional packs from its own bundles and did not start. To fix it, run: delorun recover packs`)
  }
}
