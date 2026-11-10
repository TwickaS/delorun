/**
 * The launcher's build facts: which runtime closure a machine installs, and the two host lists its release-log check
 * reads under. Contract C1's release-file list and contract C18's log list are separate, and the service the launcher
 * composes in `bin.ts` reads the log's origin through the log's list — the install path refuses every log answer when
 * the log's host is missing from the rule the log is read under, and an install needs a passing online check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELEASE_DOWNLOAD_HOSTS } from '@delo/contract-home-layout'
import { Downloader, createTilesLogService, isInstallError } from '@delo/install'
import { RELEASE_SOURCE, RELEASE_HOSTS } from '@delo/install'
import { BUILD_CONSTANTS, buildOrigin, channelPlan, logPlan, RELEASE_LOG_DISTRIBUTOR_ORIGIN, RELEASE_LOG_HOSTS, RELEASE_LOG_TILES_ORIGIN, platformOf } from '../src/platform.ts'

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

describe('the origins a build fixes', () => {
  it('uses the production channel and the public log when the build names none, as a source run does', () => {
    expect(BUILD_CONSTANTS).toEqual({})
    expect(channelPlan()).toEqual({ source: RELEASE_SOURCE, rule: RELEASE_HOSTS })
    expect(logPlan()).toEqual({ origin: RELEASE_LOG_TILES_ORIGIN, hosts: RELEASE_LOG_HOSTS })
  })

  it('serves every file of a built channel below its origin, in the layout GitHub Releases gives, and allows that host only', () => {
    const plan = channelPlan({ channelOrigin: 'http://127.0.0.1:8123/' })
    expect(plan.source.metadata).toBe('http://127.0.0.1:8123')
    expect(plan.source.files('0.1.0' as never, 'delorun-0.1.0.manifest.json')).toBe('http://127.0.0.1:8123/releases/download/v0.1.0/delorun-0.1.0.manifest.json')
    expect(plan.rule).toEqual({ scheme: 'http:', hosts: ['127.0.0.1'], maxRedirects: RELEASE_HOSTS.maxRedirects })
  })

  it('reads the built log from its one origin, and no distributor', () => {
    expect(logPlan({ logOrigin: 'https://log.example.test' })).toEqual({ origin: 'https://log.example.test', hosts: ['log.example.test'] })
  })

  it('accepts https and loopback http origins and nothing else', () => {
    expect(buildOrigin('https://channel.example.test', 'channel origin')).toBe('https://channel.example.test')
    expect(buildOrigin('http://localhost:9', 'channel origin')).toBe('http://localhost:9')
    expect(buildOrigin('http://[::1]:9', 'channel origin')).toBe('http://[::1]:9')
    expect(() => buildOrigin('http://channel.example.test', 'channel origin')).toThrow('must use https, or http on this machine\'s loopback address')
    expect(() => buildOrigin('ftp://127.0.0.1', 'channel origin')).toThrow('must use https')
    expect(() => buildOrigin('https://channel.example.test/path', 'channel origin')).toThrow('must be an origin')
    expect(() => buildOrigin('https://channel.example.test/?q=1', 'log origin')).toThrow('the log origin https://channel.example.test/?q=1 must be an origin')
    const login = ['someone', 'something'].join(':')
    expect(() => buildOrigin(`https://${login}@channel.example.test`, 'channel origin')).toThrow('credentials')
    expect(() => buildOrigin('not a url', 'channel origin')).toThrow('is not a URL')
  })
})

describe('a build that fixed its origins', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('uses the origins the bundler wrote in place of the production ones', async () => {
    vi.stubGlobal('__DELO_LAUNCHER_BUILD__', { channelOrigin: 'http://127.0.0.1:8123', logOrigin: 'http://127.0.0.1:8124' })
    vi.resetModules()
    const built = await import('../src/platform.ts')
    expect(built.BUILD_CONSTANTS).toEqual({ channelOrigin: 'http://127.0.0.1:8123', logOrigin: 'http://127.0.0.1:8124' })
    expect(built.channelPlan().source.metadata).toBe('http://127.0.0.1:8123')
    expect(built.logPlan().origin).toBe('http://127.0.0.1:8124')
  })
})
