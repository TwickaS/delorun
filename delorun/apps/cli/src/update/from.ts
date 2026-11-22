/**
 * `delorun update --from <folder|https-address>`: install the release that a person-supplied source holds, through the
 * same verification as a channel update ([channel](./channel.ts)). The CLI process installs the verified release into
 * the runtime store, which never switches `current`, and then asks the home process to prepare that installed version:
 * the home process fetches nothing from the person's address, and the update channel's requests name no address.
 *
 * Only the freshness of the release channel's timestamp is relaxed, and only after the person agrees to the question
 * below at a terminal. `--yes`, a missing terminal, a signature, the release-log bundle or a failed online check, the
 * root chain and the downgrade floor refuse. The stored timestamp is not replaced, and the release-log check state is
 * recorded `unchecked` when the online check did not run.
 *
 * @module @delorun/cli/update/from
 */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { isInstallError, LauncherChannel, manualSource, messageOf, newestManifestVersion, readChannelRecord } from '@delorun/install'
import type { RuntimeStore, UpdateInstallEvent } from '@delorun/runtime-store'
import { CliError, EXIT } from '../exit.ts'
import { recordedLogTransport } from './channel.ts'
import type { LauncherAnchor } from './trusted-root.ts'

/** What {@link installFrom} needs. */
export interface InstallFromOptions {
  /** The resolved Delorun home. */
  readonly home: string
  /** The folder or `https:` address. */
  readonly from: string
  /** Whether the person passed `--yes`, which never confirms an unconfirmed release. */
  readonly yes: boolean
  /** The version this process runs, whose channel is the person's. */
  readonly running: RuntimeVersion
  /** The launcher's roots and the stored root anchored on them. */
  readonly anchor: LauncherAnchor
  /** The home's runtime store. */
  readonly store: Pick<RuntimeStore, 'install' | 'pointers' | 'startCheckRuntime' | 'paths'>
  /** The interval of the start check's full hash in days. */
  readonly fullCheckDays: number
  /**
   * Ask the person a yes/no question.
   * @param message - the question.
   * @returns the answer, or `undefined` when there is no terminal to ask.
   */
  readonly confirm: (message: string) => Promise<boolean | undefined>
  /** Told of each step of the install, which the command draws. */
  readonly report: (event: UpdateInstallEvent) => void
  /** The `fetch` of the release log; this process's by default. */
  readonly fetch?: typeof globalThis.fetch
  /** The clock in milliseconds; `Date.now` by default. */
  readonly now?: () => number
}

/**
 * Refuse a folder source that is not a folder, before any file is looked up in it.
 * @param from - the folder or `https:` address.
 * @throws {Error} when `from` is a path that does not exist or is not a folder.
 */
async function requireFolder(from: string): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(from)) return
  const path = resolve(from)
  const found = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`the folder ${path} does not exist`, { cause: error })
    throw error
  })
  if (!found.isDirectory()) throw new Error(`${path} is not a folder`)
}

/**
 * Verify and install a release from a person-supplied source.
 * @param options - the source, the store, the anchors and the question.
 * @returns the version to prepare: the release installed, or the version that runs when the source holds that one.
 * @throws {CliError} when `http:` or another scheme is named, a release file is missing (the file is named), a check
 *   refuses, the release is below the floor, the release channel cannot confirm it and `--yes` or no terminal cannot
 *   agree, or the person declines.
 */
export async function installFrom(options: InstallFromOptions): Promise<RuntimeVersion> {
  const fail = (error: unknown): CliError => new CliError(EXIT.failed, isInstallError(error)
    ? `delorun update --from: ${error.code} (${error.source}): ${error.message}. Nothing was installed.`
    : `delorun update --from: ${messageOf(error)}. Nothing was installed.`)
  try {
    await requireFolder(options.from)
    const manual = manualSource(options.from)
    const { current } = await options.store.pointers()
    const running = await options.store.startCheckRuntime(options.running, await options.anchor.root(), options.fullCheckDays)
    const origins = await readChannelRecord(options.home) ?? {}
    const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    const version = await newestManifestVersion(options.from)
    const channel = new LauncherChannel({
      home: options.home,
      platform: options.store.paths.platform,
      roots: await options.anchor.shipped(),
      channel: running.manifest.channel,
      log: root => recordedLogTransport(origins, root, fetch),
      productionRoot: origins.channelOrigin === undefined,
      source: manual.source,
      downloader: manual.downloader,
      progress: options.report,
      ...options.now === undefined ? {} : { now: options.now },
      unconfirmed: {
        ...version === undefined ? {} : { version },
        floor: current,
        allow: async ({ version: release, reason }) => {
          if (options.yes) throw new CliError(EXIT.failed, `delorun update --from: the release channel cannot confirm that ${release} is current (${reason}), and --yes does not agree to that; run delorun update --from ${options.from} without --yes in a terminal. Nothing was installed.`)
          const answer = await options.confirm(`The release channel cannot confirm that ${release} is current (${reason}). Install ${release} from ${options.from} on its signature and release-log entry alone?`)
          if (answer === undefined) throw new CliError(EXIT.failed, `delorun update --from: the release channel cannot confirm that ${release} is current (${reason}), and agreeing needs a terminal to ask in, and there is none. Nothing was installed.`)
          return answer
        },
      },
    })
    const release = await channel.resolve()
    if (release.version === current) return release.version
    await options.store.install({
      version: release.version,
      root: release.root,
      fill: async (directory) => {
        const files = await channel.fill(release, directory)
        options.report({ step: 'installing', version: release.version })
        return files
      },
    })
    await channel.recordInstalled(release)
    options.report({ step: 'installed', version: release.version })
    return release.version
  } catch (error) {
    throw error instanceof CliError ? error : fail(error)
  }
}
