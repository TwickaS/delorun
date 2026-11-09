/**
 * The launcher's build facts: which runtime closure a machine installs, and the two host lists its release-log check
 * reads under. Contract C1's release-file list and contract C18's log list are separate, and the service the launcher
 * composes in `bin.ts` reads the log's origin through the log's list — the install path refuses every log answer when
 * the log's host is missing from the rule the log is read under, and an install needs a passing online check.
 */
import { describe, expect, it } from 'vitest'
import { RELEASE_DOWNLOAD_HOSTS } from '@delo/contract-home-layout'
import { Downloader, createTilesLogService, isInstallError } from '@delo/install'
import { RELEASE_LOG_DISTRIBUTOR_ORIGIN, RELEASE_LOG_HOSTS, RELEASE_LOG_TILES_ORIGIN, platformOf } from '../src/platform.ts'

/** The note a stand-in log answers with; the service returns it unchanged. */
const NOTE = 'rekor.sigstore.dev - 1\n42\n' + 'AA==\n'

describe('the platform a machine installs', () => {
  it('names the closure of a pair contract C2 publishes, and refuses one it does not', () => {
    expect(platformOf('linux', 'x64')).toBe('linux-x64')
    expect(() => platformOf('plan9', 'vax')).toThrow(/Delo publishes a runtime for/)
  })
})

describe('the release-log host list', () => {
  it('names the log’s own origin and the witness distributor, and no release-file host', () => {
    expect(RELEASE_LOG_HOSTS).toContain(new URL(RELEASE_LOG_TILES_ORIGIN).hostname)
    expect(RELEASE_LOG_HOSTS).toContain(new URL(RELEASE_LOG_DISTRIBUTOR_ORIGIN).hostname)
    expect(RELEASE_LOG_HOSTS).toHaveLength(2)
    for (const host of RELEASE_DOWNLOAD_HOSTS) expect(RELEASE_LOG_HOSTS).not.toContain(host)
    for (const host of RELEASE_LOG_HOSTS) expect(RELEASE_DOWNLOAD_HOSTS).not.toContain(host)
  })

  it('lets the launcher’s composed service read the log’s checkpoint from the log’s origin', async () => {
    const asked: string[] = []
    const downloader = new Downloader({
      fetch: (url) => {
        asked.push(String(url))
        return Promise.resolve(new Response(NOTE, { status: 200 }))
      },
    })
    const service = createTilesLogService({ origin: RELEASE_LOG_TILES_ORIGIN, hosts: RELEASE_LOG_HOSTS, downloader })
    expect(await service.checkpoint()).toBe(NOTE)
    expect(asked).toEqual([`${RELEASE_LOG_TILES_ORIGIN}/checkpoint`])
  })

  it('refuses the log’s host under the release-file rule, so no install passes the online check while the two are one list', async () => {
    const error: unknown = await new Downloader().bytes(`${RELEASE_LOG_TILES_ORIGIN}/checkpoint`, 1_024).then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'DOWNLOAD_REFUSED')).toBe(true)
    expect(error instanceof Error ? error.message : String(error)).toContain(`${new URL(RELEASE_LOG_TILES_ORIGIN).hostname} is not an allowed host`)
  })
})
