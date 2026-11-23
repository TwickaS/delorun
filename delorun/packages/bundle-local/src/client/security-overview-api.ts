/**
 * The security overview's data half: it reads the facts {@link overviewRows} needs from the Host's existing routes,
 * each on its own, so one route that a remote device may not read, or a profile does not mount, leaves only its own
 * fact `null` (the row then asks for a look) and never hides the others. The trust bill and its freshness come from the
 * trust badge's store, which already reads them.
 *
 * Reads happen when the overview opens and every {@link OVERVIEW_POLL_MS} while it stays open; none of them hashes.
 * @module @delorun/bundle-local/client/security-overview-api
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { UPDATE_NOTICE_PATH } from '@delorun/contract-update-report'
import { z } from 'zod'
import { readAgentLevels, readEverywhereStrict, readWaitingServers, readWorkspaces } from './consents-api.ts'
import { readDevices } from './devices-api.ts'
import type { HostFetch } from './host-api.ts'
import { readPinState } from './pin-api.ts'
import { readProtection, readRunState } from './run-settings-api.ts'
import type { OverviewFacts } from './security-overview.ts'

/** How often the open overview reads its facts again, in milliseconds. */
export const OVERVIEW_POLL_MS = 30_000

/** The facts other than the trust bill, its freshness and the clock. */
export type OverviewHostFacts = Omit<OverviewFacts, 'bill' | 'checks' | 'now'>

/** The facts before the first read: nothing known. */
export const NO_HOST_FACTS: OverviewHostFacts = {
  run: null, everywhere: null, workspaces: null, protection: null, devices: null, pin: null, mcpWaiting: null, agentLevels: null, update: null,
}

/** The fields of the update notice the overview reads. */
const UpdateNoticeSchema = z.object({
  notice: z.object({ release: z.object({ delorun: z.string(), security: z.boolean() }) }).nullable(),
})

/**
 * A fact, or `null` when its route fails or is not mounted.
 * @param read - the read.
 * @returns the fact.
 */
async function fact<T>(read: () => Promise<T | undefined>): Promise<T | null> {
  try {
    return (await read()) ?? null
  } catch (_unreadable) {
    // A refused, unmounted or unreachable route leaves this fact unknown; the row says it could not be read.
    return null
  }
}

/**
 * Read the newer release the Host knows of.
 * @param fetch - the page's fetch.
 * @returns its version and whether it is a security release, or `null` when none is known or the route fails.
 */
async function readUpdate(fetch: HostFetch): Promise<OverviewFacts['update']> {
  const response = await fetch(UPDATE_NOTICE_PATH.slice(1), { headers: { accept: 'application/json' } })
  if (!response.ok) return null
  const parsed = UpdateNoticeSchema.safeParse(await response.json())
  if (!parsed.success || parsed.data.notice === null) return null
  return { version: parsed.data.notice.release.delorun, security: parsed.data.notice.release.security }
}

/**
 * Read every fact the overview needs besides the trust bill.
 * @param fetch - the page's fetch.
 * @returns the facts, each `null` when its route could not be read.
 */
export async function readOverviewFacts(fetch: HostFetch): Promise<OverviewHostFacts> {
  const [run, everywhere, workspaces, protection, devices, pin, waiting, levels, update] = await Promise.all([
    fact(() => readRunState(fetch)),
    fact(async () => {
      const answer = await readEverywhereStrict(fetch)
      return answer.problem === undefined ? answer : undefined
    }),
    fact(() => readWorkspaces(fetch)),
    fact(() => readProtection(fetch)),
    fact(() => readDevices(fetch)),
    fact(() => readPinState(fetch)),
    fact(() => readWaitingServers(fetch)),
    fact(() => readAgentLevels(fetch)),
    fact(() => readUpdate(fetch)),
  ])
  return {
    run,
    everywhere: everywhere === null ? null : { on: everywhere.on, ...everywhere.grantedAt === undefined ? {} : { grantedAt: everywhere.grantedAt } },
    workspaces: workspaces?.workspaces ?? null,
    protection,
    devices: devices?.devices ?? null,
    pin: pin === null ? null : { on: pin.kind === 'on' },
    mcpWaiting: waiting?.length ?? null,
    agentLevels: levels?.levels ?? null,
    update,
  }
}

/** The overview's facts the Host last answered. */
export class OverviewStore {
  /** The facts, {@link NO_HOST_FACTS} until the first read. */
  readonly facts = createSnapshotStore<OverviewHostFacts>(NO_HOST_FACTS)
  /** Whether the first read has finished. */
  readonly loaded = createSnapshotStore<boolean>(false)
  /** The page's fetch. */
  private readonly fetch: HostFetch

  /**
   * @param fetch - the page's fetch.
   */
  constructor(fetch: HostFetch) {
    this.fetch = fetch
  }

  /**
   * Read the facts now and every {@link OVERVIEW_POLL_MS} until the disposer runs; the overview calls it when it opens.
   * @returns the disposer.
   */
  watch(): () => void {
    let live = true
    const read = (): void => {
      void readOverviewFacts(this.fetch).then((facts) => {
        if (!live) return
        this.facts.set(facts)
        this.loaded.set(true)
      })
    }
    read()
    const timer = setInterval(read, OVERVIEW_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }

  /**
   * Read the facts once more now, such as after an action changed one.
   * @returns once the read finished.
   */
  async reload(): Promise<void> {
    this.facts.set(await readOverviewFacts(this.fetch))
    this.loaded.set(true)
  }
}
