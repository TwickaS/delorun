/**
 * The trusted root of every update, rollback and health check this runtime runs: `trust/root.json`, anchored on the
 * release roots the launcher that started this process ships, by the chain an install walked to it, as the launcher's
 * own start anchors it (contract C1, launch protocol 1). The launcher names its roots' directory in
 * `DELO_LAUNCHER_ROOTS`; a home process started by an update inherits it from the one before.
 *
 * A process the launcher did not start, such as a runtime run by hand from `runtimes/<version>/`, has no roots to
 * anchor on. It refuses with `ROOT_NOT_ANCHORED` and installs, updates and rolls back to nothing, because a root held
 * to its own signatures only is one any process running as the person could have written. Its start was not checked
 * by the launcher either, and nothing it would install could be trusted more than that.
 *
 * @module @delo/cli/update/trusted-root
 */
import { DELO_LAUNCHER_ROOTS_ENV, TRUST_FILES } from '@delo/contract-home-layout'
import type { RootMetadata } from '@delo/contract-release-manifest'
import { messageOf, readAnchoredRoot, readShippedRoots, trustFile } from '@delo/install'
import { RuntimeStoreError, type TrustedRootSource } from '@delo/runtime-store'

/** What a person does when no launcher roots anchor the stored root. */
const START_WITH_LAUNCHER = 'start Delo with its launcher, the delorun command that npm or the install script installed, and run this again'

/** The anchors one process reads: the roots its launcher ships and the stored root anchored on them. */
export interface LauncherAnchor {
  /**
   * The root files the launcher ships, oldest first: the roots an update's release channel walks from.
   * @returns the files.
   * @throws {RuntimeStoreError} `ROOT_NOT_ANCHORED` when the launcher named none or they do not read.
   */
  readonly shipped: () => Promise<readonly Uint8Array[]>
  /** The stored root, anchored on {@link LauncherAnchor.shipped}. */
  readonly root: TrustedRootSource
}

/**
 * The anchors of this home for a process started with this environment.
 * @param home - the resolved Delo home.
 * @param env - the process's environment, read for `DELO_LAUNCHER_ROOTS`.
 * @returns the anchors; each call reads the files again, so a root an update stored is read as it stands.
 */
export function launcherAnchor(home: string, env: Readonly<Record<string, string | undefined>>): LauncherAnchor {
  const path = trustFile(home, TRUST_FILES.root)
  const directory = env[DELO_LAUNCHER_ROOTS_ENV]
  const shipped = async (): Promise<readonly Uint8Array[]> => {
    if (directory === undefined || directory === '') {
      throw new RuntimeStoreError('ROOT_NOT_ANCHORED', path, `this Delo was not started by its launcher, which names the release roots it ships in ${DELO_LAUNCHER_ROOTS_ENV}, so the root stored at ${path} cannot be anchored and no release is installed or started from it; ${START_WITH_LAUNCHER}`)
    }
    try {
      return await readShippedRoots(directory)
    } catch (error) {
      throw new RuntimeStoreError('ROOT_NOT_ANCHORED', path, `the release roots of the launcher that started this Delo, at ${directory}, do not read (${messageOf(error)}), so the root stored at ${path} cannot be anchored; reinstall the launcher, then ${START_WITH_LAUNCHER}`, [], { cause: error })
    }
  }
  const root = async (): Promise<RootMetadata> => {
    const roots = await shipped()
    try {
      return (await readAnchoredRoot(home, roots)).metadata
    } catch (error) {
      throw new RuntimeStoreError('ROOT_NOT_ANCHORED', path, `the root stored at ${path} is not one the launcher's release roots lead to (${messageOf(error)}), so no release is installed or started from it; install Delo again with its launcher`, ['reinstall'], { cause: error })
    }
  }
  return { shipped, root }
}
