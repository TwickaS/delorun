/**
 * The update check in a running Host (design `delo/docs/design/update-notice.md`): `delorun` attaches the check of
 * [notice](./notice.ts) to the `deloUpdateCheck` service of `@delo/bundle-local`'s `delo-update-check` row, which runs
 * it at start when it is due and on the row's interval, and serves its notice to the studio. The terminal line is
 * written once per newer version the Host learns of. With the row's switch off the service is absent, so no check
 * runs, and the record a start finds is removed, so no later start prints a line the person turned off.
 *
 * @module @delo/cli/update/notice-host
 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { RuntimePlatform } from '@delo/contract-release-manifest'
import type { UpdateCheckRecord } from '@delo/contract-update-report'
import type { UpdateCheckSource, UpdateCheckState } from '@delo/bundle-local/update-check'
import type { TrustedRootSource } from '@delo/runtime-store'
import { messageOf } from '@delo/install'
import { printable } from '../terminal-text.ts'
import { runtimePlatformOf, type Publication } from './channel.ts'
import { runtimeOfFile } from './runtime.ts'
import { launcherAnchor, type LauncherAnchor } from './trusted-root.ts'
import { checkForUpdate, noticeLine, noticeOf, profileReader, readUpdateCheck, readUpdateNotes, removeUpdateCheck, runningRelease, type RunningRelease } from './notice.ts'

/** What the Host's check needs. */
export interface UpdateWatchOptions {
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The runtime platform. */
  readonly platform: RuntimePlatform
  /** The version this process runs from the store. */
  readonly running: RuntimeVersion
  /** The launcher's roots and the stored root anchored on them ([trusted root](./trusted-root.ts)). */
  readonly anchor: LauncherAnchor
  /**
   * Writes the notice's terminal line.
   * @param text - the line, without a newline.
   */
  readonly line: (text: string) => void
  /** The fetch every request goes through; this process's by default. */
  readonly fetch?: typeof globalThis.fetch
  /** Where the files are published, and their hosts; the installation's recorded channel by default. */
  readonly publication?: Publication
  /** The clock; `Date` by default. */
  readonly now?: () => Date
  /**
   * Writes a failure the person does not need in the terminal to the home log; nowhere by default.
   * @param text - the line, already escaped.
   */
  readonly log?: (text: string) => void
}

/**
 * The check `delorun` attaches to the Host's `deloUpdateCheck` service.
 * @param options - the home, the profile, the platform, the running version, the terminal line and the log.
 * @returns the source: `read` answers from the record, `check` runs one check. The plugin count is computed once per
 *   record, when a check writes one or a start reads one, and kept with it, so a studio's reads do not reread every
 *   plugin manifest.
 */
export function updateCheckSource(options: UpdateWatchOptions): UpdateCheckSource {
  let release: Promise<RunningRelease> | undefined
  let announced: string | undefined
  let cached: { readonly key: string, readonly state: UpdateCheckState } | undefined
  const profile = profileReader(options.home, options.profile)
  const running = async (): Promise<RunningRelease> => {
    release ??= options.anchor.root().then(root => runningRelease(options.home, options.platform, options.running, root))
    try {
      return await release
    } catch (error) {
      // A read that failed, such as one racing an update's switch, is tried again next time rather than kept.
      release = undefined
      throw error
    }
  }
  const stateOf = async (record: UpdateCheckRecord | undefined): Promise<UpdateCheckState> => {
    const key = JSON.stringify(record ?? null)
    if (cached?.key === key) return cached.state
    const notice = await noticeOf(record, await running(), profile)
    if (notice !== undefined && announced !== notice.release.delo) {
      announced = notice.release.delo
      options.line(noticeLine(notice))
    }
    const state: UpdateCheckState = {
      ...record === undefined ? {} : { checked: Date.parse(record.checked) },
      ...record?.failure === undefined ? {} : { failed: true },
      ...notice === undefined ? {} : { notice },
    }
    cached = { key, state }
    return state
  }
  return {
    read: async () => stateOf(await readUpdateCheck(options.home, options.profile)),
    check: async timeoutMs => stateOf(await checkForUpdate({ ...options, timeoutMs })),
    notes: async () => {
      const record = await readUpdateCheck(options.home, options.profile)
      const text = await readUpdateNotes(options.home, options.profile, record)
      return text === undefined || record?.newest === undefined ? undefined : { version: record.newest.delo, text }
    },
  }
}

/**
 * Attach the check to the booted Host's `deloUpdateCheck` service whenever the service is present, and remove the
 * profile's record when the booted Host has none, because the person switched the check off. Nothing here fails a
 * start: a record that cannot be removed is logged and left.
 * @param ctx - the booted profile's root context, after its startup settled.
 * @param options - the home, the profile, the platform, the running version, the terminal line and the log.
 * @returns once the record is removed or the attachment is registered; the attachment is an effect of `ctx`.
 */
export async function watchUpdates(ctx: Context, options: UpdateWatchOptions): Promise<void> {
  if (ctx.get('deloUpdateCheck') === undefined) {
    try {
      await removeUpdateCheck(options.home, options.profile)
    } catch (error) {
      options.log?.(`delo-update-check: the update check's record could not be removed: ${printable(messageOf(error))}`)
    }
  }
  const source = updateCheckSource(options)
  ctx.inject(['deloUpdateCheck'], (scope) => {
    scope.effect(() => scope.deloUpdateCheck.attach(source))
  })
}

/**
 * The line a start that leaves the Host in the background prints from the last check, when this command runs from the
 * store; a source checkout checks no channel.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param env - this process's environment, read for the launcher's roots.
 * @param file - a file of this package, which tells where it runs from; this module by default.
 * @returns the line, or `undefined`.
 */
export async function startNoticeLine(home: string, profile: string, env: Readonly<Record<string, string | undefined>>, file: string = fileURLToPath(import.meta.url)): Promise<string | undefined> {
  const runtime = runtimeOfFile(home, file)
  return runtime.store ? recordedNoticeLine(home, profile, runtimePlatformOf(process.platform, process.arch), runtime.version, launcherAnchor(home, env).root) : undefined
}

/**
 * The line a start prints from the last check, for a start that leaves the Host running in the background.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param platform - the runtime platform.
 * @param running - the version this process runs from the store.
 * @param root - the stored root, anchored on the launcher's roots.
 * @returns the line, or `undefined` when no newer release is recorded or the record or the running release cannot be
 *   read; a start never fails for it.
 */
export async function recordedNoticeLine(home: string, profile: string, platform: RuntimePlatform, running: RuntimeVersion, root: TrustedRootSource): Promise<string | undefined> {
  try {
    const notice = await noticeOf(await readUpdateCheck(home, profile), await runningRelease(home, platform, running, await root()), profileReader(home, profile))
    return notice === undefined ? undefined : noticeLine(notice)
  } catch (_unreadable) {
    // The running release's signed files or the profile did not read: the start says nothing about updates.
    return undefined
  }
}
