/**
 * The launcher's build facts: which runtime closure a machine installs, where its channel is, and which log its
 * release-log check reads. The log is the one the trusted root names, read under a host rule of its own: contract C1's
 * release-file list and contract C18's log rule are separate, so the install path refuses a log answer from a host the
 * log's rule does not name, and a release file from the log's host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELEASE_DOWNLOAD_HOSTS } from '@delorun/contract-home-layout'
import { Downloader, isInstallError } from '@delorun/install'
import { logEndpoints, tilesTransport } from '@delorun/release-verify/transport'
import { RELEASE_SOURCE, RELEASE_HOSTS } from '@delorun/install'
import { buildOrigin } from '@delorun/install'
import { BUILD_CONSTANTS, channelPlan, hostRefusal, logPlan, platformOf, RELEASE_LOG_API_PREFIX } from '../src/platform.ts'

describe('the platform a machine installs', () => {
  it('names the closure of a pair contract C2 publishes, and refuses one it does not', () => {
    expect(platformOf('linux', 'x64')).toBe('linux-x64')
    expect(() => platformOf('plan9', 'vax')).toThrow(/^Delorun has no runtime for plan9-vax; a release can publish one only for /u)
  })
})

describe('the hosts Delorun 0.1.0 refuses before any download', () => {
  it('names WSL2 for native Windows, a later release for macOS, and the guide for both', () => {
    expect(hostRefusal('win32')).toMatch(/^Delorun 0\.1\.0 runs in WSL2, not on native Windows\. Nothing was downloaded\..*#windows-through-wsl2$/u)
    expect(hostRefusal('darwin')).toMatch(/^Delorun 0\.1\.0 does not run on macOS yet; macOS joins in a later release\..*#windows-through-wsl2$/u)
  })

  it('leaves every other host to the release’s own platform list', () => {
    expect(hostRefusal('linux')).toBeUndefined()
    expect(hostRefusal('freebsd')).toBeUndefined()
  })
})

describe('the release log a build reads', () => {
  it('is the log the trusted root names, at the Rekor v2 path of that host, and no other host', () => {
    expect(logPlan('log2025-1.rekor.sigstore.dev')).toEqual({ origin: 'https://log2025-1.rekor.sigstore.dev/api/v2', hosts: ['log2025-1.rekor.sigstore.dev'] })
    expect(logPlan('Log.Example.test:8443')).toEqual({ origin: 'https://log.example.test:8443/api/v2', hosts: ['log.example.test'] })
    expect(RELEASE_LOG_API_PREFIX).toBe('/api/v2')
  })

  it('derives the production endpoints only from the trusted root\'s log origin, as delorun verify does', () => {
    for (const origin of ['log2025-1.rekor.sigstore.dev', 'log.example.test:8443']) {
      const root = { log: { origin, vkey: '' } } as Parameters<typeof logEndpoints>[0]
      expect(logPlan(origin).origin).toBe(logEndpoints(root).tiles)
      expect(`${logPlan(origin).origin}/checkpoint`).toBe(logEndpoints(root).checkpoint)
    }
  })

  it('has no log host of its own in the production build, so no constant can differ from the root', () => {
    expect(BUILD_CONSTANTS).toEqual({})
    for (const host of RELEASE_DOWNLOAD_HOSTS) expect(logPlan('log2025-1.rekor.sigstore.dev').hosts).not.toContain(host)
    const root = { log: { origin: 'log2025-1.rekor.sigstore.dev' } }
    expect(new URL(logPlan(root.log.origin).origin).hostname).toBe(root.log.origin)
  })

  it('refuses a root whose log origin is not a host', () => {
    expect(() => logPlan('log.example.test/release-log')).toThrow('which is not a host with an optional port')
    expect(() => logPlan('https://log.example.test')).toThrow('is not a host')
    const login = ['someone', 'something'].join(':')
    expect(() => logPlan(`${login}@log.example.test`)).toThrow('is not a host')
    expect(() => logPlan('')).toThrow('is not a host')
  })

  it('reads the one origin a local build names instead, with no path rule from the root', () => {
    expect(logPlan('log.example.test/release-log', { logOrigin: 'http://127.0.0.1:8124' })).toEqual({ origin: 'http://127.0.0.1:8124', hosts: ['127.0.0.1'] })
  })

  it('lets the launcher’s composed transport read the log’s checkpoint from the host the root names', async () => {
    const asked: string[] = []
    const plan = logPlan('log2025-1.rekor.sigstore.dev')
    const transport = tilesTransport({ fetch: url => { asked.push(String(url)); return Promise.resolve(new Response('note', { status: 200 })) }, checkpoint: `${plan.origin}/checkpoint`, tiles: plan.origin })
    expect(await transport.latestCheckpoint(new AbortController().signal)).toBe('note')
    expect(asked).toEqual(['https://log2025-1.rekor.sigstore.dev/api/v2/checkpoint'])
  })

  it('refuses the log’s host under the release-file rule, so the two rules stay apart', async () => {
    const error: unknown = await new Downloader().bytes('https://log2025-1.rekor.sigstore.dev/api/v2/checkpoint', 1_024).then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'DOWNLOAD_REFUSED')).toBe(true)
    expect(error instanceof Error ? error.message : String(error)).toContain('log2025-1.rekor.sigstore.dev is not an allowed host')
  })
})

describe('the origins a build fixes', () => {
  it('uses the production channel and the public log when the build names none, as a source run does', () => {
    expect(BUILD_CONSTANTS).toEqual({})
    expect(channelPlan()).toEqual({ source: RELEASE_SOURCE, rule: RELEASE_HOSTS })
  })

  it('serves every file of a built channel below its origin, in the layout GitHub Releases gives, and allows that host only', () => {
    const plan = channelPlan({ channelOrigin: 'http://127.0.0.1:8123/' })
    expect(plan.source.metadata).toBe('http://127.0.0.1:8123')
    expect(plan.source.files('0.1.0' as never, 'delorun-0.1.0.manifest.json')).toBe('http://127.0.0.1:8123/releases/download/v0.1.0/delorun-0.1.0.manifest.json')
    expect(plan.rule).toEqual({ scheme: 'http:', hosts: ['127.0.0.1'], maxRedirects: RELEASE_HOSTS.maxRedirects })
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
    vi.stubGlobal('__DELORUN_LAUNCHER_BUILD__', { channelOrigin: 'http://127.0.0.1:8123', logOrigin: 'http://127.0.0.1:8124' })
    vi.resetModules()
    const built = await import('../src/platform.ts')
    expect(built.BUILD_CONSTANTS).toEqual({ channelOrigin: 'http://127.0.0.1:8123', logOrigin: 'http://127.0.0.1:8124' })
    expect(built.channelPlan().source.metadata).toBe('http://127.0.0.1:8123')
    expect(built.logPlan('log.example.test').origin).toBe('http://127.0.0.1:8124')
  })
})
