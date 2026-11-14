/**
 * The sidebar's update notice, data half: the harness's answer on `UPDATE_NOTICE_PATH`, validated, and the version
 * the person dismissed. The studio reads the route when it starts, on each new connection generation, when the window
 * regains focus or becomes visible, and at the configured interval. A 404 (the check is switched off), a failed request
 * and an answer that does not validate all read as no notice.
 * @module @delo/plugin-sidebar/client/update-notice
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { isValidSummary, type SemanticVersion, type Sha256Hex } from '@delo/contract-release-manifest'
import { UPDATE_NOTES_PATH, UPDATE_NOTICE_PATH, type UpdateNotice, type UpdateNoticeResponse } from '@delo/contract-update-report'
import { z } from 'zod'

/** A semantic version without a leading `v`: the core, then an optional prerelease and build. */
const SEMANTIC_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/

const version = z.string().regex(SEMANTIC_VERSION).transform(text => brandString<SemanticVersion>(text))

/** The route's answer, validated and typed as the contract's {@link UpdateNoticeResponse}. Unknown fields are dropped. */
export const UpdateNoticeResponseSchema: z.ZodType<UpdateNoticeResponse> = z.object({
  notice: z.object({
    running: z.object({ delo: version, dsh: version }),
    release: z.object({
      delo: version,
      dsh: version,
      channel: z.enum(['stable', 'beta']),
      security: z.boolean(),
      summary: z.string().refine(isValidSummary).optional(),
      notes: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/u).transform(text => brandString<Sha256Hex>(text)), length: z.number().int().min(1) }).optional(),
    }),
    kind: z.enum(['patch', 'minor', 'major']),
    disables: z.number().int().nonnegative(),
  }).nullable(),
}).transform(({ notice }): UpdateNoticeResponse => ({
  notice: notice === null ? null : {
    running: notice.running,
    release: {
      delo: notice.release.delo, dsh: notice.release.dsh, channel: notice.release.channel, security: notice.release.security,
      ...notice.release.summary === undefined ? {} : { summary: notice.release.summary },
      ...notice.release.notes === undefined ? {} : { notes: notice.release.notes },
    },
    kind: notice.kind,
    disables: notice.disables,
  },
}))

/**
 * Read the notice from the harness, document-relative as the studio's other routes.
 * @param signal - aborts the read.
 * @returns the notice, or null for none, a 404, a failed request or an answer that does not validate.
 */
export async function fetchUpdateNotice(signal: AbortSignal): Promise<UpdateNotice | null> {
  try {
    const response = await fetch(UPDATE_NOTICE_PATH.slice(1), { headers: { accept: 'application/json' }, signal })
    if (!response.ok) return null
    const parsed = UpdateNoticeResponseSchema.safeParse(await response.json())
    return parsed.success ? parsed.data.notice : null
  } catch (_error) {
    // A failed request or a body that is not JSON is no notice; the next read tries again.
    return null
  }
}

/**
 * Read the verified release notes of the notice's release from the harness.
 * @param signal - aborts the read.
 * @returns the plain-text notes with the release they belong to, or null for none, a 404, a failed request or an answer that does not validate.
 */
export async function fetchUpdateNotes(signal: AbortSignal): Promise<{ readonly version: SemanticVersion, readonly notes: string } | null> {
  try {
    const response = await fetch(UPDATE_NOTES_PATH.slice(1), { headers: { accept: 'application/json' }, signal })
    if (!response.ok) return null
    const parsed = z.object({ version: version.nullable(), notes: z.string().nullable() }).safeParse(await response.json())
    return parsed.success && parsed.data.version !== null && parsed.data.notes !== null ? { version: parsed.data.version, notes: parsed.data.notes } : null
  } catch (_error) {
    // A failed request or a body that is not JSON shows no notes; opening the notes again tries again.
    return null
  }
}

/** Where the dismissed version is kept: a per-viewer preference, which may refuse. */
export interface DismissalStorage {
  read(key: string): string | null
  write(key: string, value: string): void
}

/** The preference key of the dismissed version, under the sidebar's preference prefix. */
export const DISMISSED_KEY = 'update.dismissed'

/** The notice the harness last answered, the dismissed version, and what the sidebar shows of them. */
export class UpdateNoticeStore {
  /** The notice the harness last answered, or null. */
  readonly answered = createSnapshotStore<UpdateNotice | null>(null)
  /** The release version the person dismissed; a storage that refuses keeps it for this page only. */
  readonly dismissed: SnapshotStore<string | null>
  /** The notice to show: the answered one unless its release is the dismissed version. */
  readonly visible: HostObservable<UpdateNotice | null> = {
    getSnapshot: () => {
      const notice = this.answered.getSnapshot()
      return notice === null || notice.release.delo === this.dismissed.getSnapshot() ? null : notice
    },
    subscribe: (listener) => {
      const stopAnswered = this.answered.subscribe(listener)
      const stopDismissed = this.dismissed.subscribe(listener)
      return () => {
        stopAnswered()
        stopDismissed()
      }
    },
  }

  /** Numbers each read, so only the latest read's answer is shown. */
  #reads = 0
  /** Reads the notice from the harness. */
  private readonly read: (signal: AbortSignal) => Promise<UpdateNotice | null>
  /** Keeps the dismissed version. */
  private readonly storage: DismissalStorage

  /**
   * @param read - reads the notice from the harness.
   * @param storage - keeps the dismissed version.
   */
  constructor(read: (signal: AbortSignal) => Promise<UpdateNotice | null>, storage: DismissalStorage) {
    this.read = read
    this.storage = storage
    this.dismissed = createSnapshotStore<string | null>(storage.read(DISMISSED_KEY))
  }

  /**
   * Hide the notice for one release; a newer release shows again.
   * @param release - the dismissed release's Delo version.
   */
  dismiss(release: SemanticVersion): void {
    this.dismissed.set(release)
    this.storage.write(DISMISSED_KEY, release)
  }

  /**
   * Read the notice now, then on each reset, focus, return to visibility and interval until the disposer runs.
   * @param refreshMinutes - the minutes between reads; a change re-arms the interval.
   * @param onReset - subscribes to new connection generations.
   * @returns the disposer that stops reading and drops every listener and timer.
   */
  start(refreshMinutes: HostObservable<number>, onReset: (listener: () => void) => () => void): () => void {
    const lifetime = new AbortController()
    const refresh = (): void => {
      const number = ++this.#reads
      void this.read(lifetime.signal).then((notice) => {
        if (!lifetime.signal.aborted && number === this.#reads) this.answered.set(notice)
      })
    }
    const visible = (): void => { if (document.visibilityState === 'visible') refresh() }
    refresh()
    let armed = refreshMinutes.getSnapshot()
    let timer = setInterval(refresh, armed * 60_000)
    const unsubscribe = refreshMinutes.subscribe(() => {
      const next = refreshMinutes.getSnapshot()
      if (next === armed) return
      armed = next
      clearInterval(timer)
      timer = setInterval(refresh, armed * 60_000)
    })
    const stopReset = onReset(refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      lifetime.abort()
      unsubscribe()
      stopReset()
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }
}
