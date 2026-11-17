/**
 * What onboarding reads about this computer: sign-ins by whether a file exists, never its contents, and how far
 * Tailscale is from serving the studio, through `tailscale` commands that only read.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TailscaleResult, TailscaleRunner } from '@delorun/reach'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeSignIn, codexSignIn, processReadinessEnvironment, readReadiness, tailscaleReadiness, type ReadinessEnvironment } from '../src/readiness.ts'

let home = ''

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'delorun-onboarding-readiness-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

const HOST = 'box.example.ts.net'
const ok = (stdout = ''): TailscaleResult => ({ code: 0, stdout, stderr: '' })
const STATUS = ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [HOST] }))

/** A `tailscale` that answers each subcommand as given and records every call. */
function tailscale(answers: Partial<Record<'version' | 'status' | 'serve', TailscaleResult>> = {}) {
  const calls: string[][] = []
  const run: TailscaleRunner = async (args) => {
    calls.push([...args])
    const key = args[0] as 'version' | 'status' | 'serve'
    return Promise.resolve(answers[key] ?? (key === 'status' ? STATUS : key === 'serve' ? ok('{}') : ok('1.90.0')))
  }
  return { run, calls }
}

const environment = (change: Partial<ReadinessEnvironment> = {}): ReadinessEnvironment => ({ env: {}, home, platform: 'linux', tailscale: tailscale().run, ...change })

/** Write a file under the scratch home whose contents no probe may read. */
async function place(path: string): Promise<void> {
  await mkdir(join(home, path, '..'), { recursive: true })
  await writeFile(join(home, path), 'never read')
}

describe('the sign-in probes', () => {
  it('find Claude Code\'s credentials file and Codex\'s auth file in the home directory', async () => {
    await place('.claude/.credentials.json')
    await place('.codex/auth.json')
    expect([await claudeSignIn(environment()), await codexSignIn(environment())]).toEqual(['found', 'found'])
  })

  it('find nothing in an empty home, and treat a directory in a file\'s place as absent', async () => {
    await mkdir(join(home, '.codex', 'auth.json'), { recursive: true })
    expect([await claudeSignIn(environment()), await codexSignIn(environment())]).toEqual(['missing', 'missing'])
  })

  it('cannot tell on macOS, where Claude Code keeps its sign-in in the Keychain', async () => {
    await place('.claude.json')
    expect(await claudeSignIn(environment({ platform: 'darwin' }))).toBe('unknown')
    expect(await claudeSignIn(environment({ platform: 'linux' }))).toBe('missing')
    expect(await claudeSignIn(environment({ platform: 'darwin', home: join(home, 'elsewhere') }))).toBe('missing')
  })

  it('follow CLAUDE_CONFIG_DIR, and ignore it when it is empty', async () => {
    await place('claude-elsewhere/.credentials.json')
    expect(await claudeSignIn(environment({ env: { CLAUDE_CONFIG_DIR: join(home, 'claude-elsewhere') } }))).toBe('found')
    expect(await claudeSignIn(environment({ env: { CLAUDE_CONFIG_DIR: join(home, 'nowhere') } }))).toBe('missing')
    await place('.claude/.credentials.json')
    expect(await claudeSignIn(environment({ env: { CLAUDE_CONFIG_DIR: '' } }))).toBe('found')
    expect(await claudeSignIn(environment({ env: { CLAUDE_CONFIG_DIR: join(home, 'nowhere') } }))).toBe('missing')
  })

  it('follow CODEX_HOME, and ignore it when it is empty', async () => {
    await place('codex-elsewhere/auth.json')
    expect(await codexSignIn(environment({ env: { CODEX_HOME: join(home, 'codex-elsewhere') } }))).toBe('found')
    expect(await codexSignIn(environment({ env: { CODEX_HOME: '' } }))).toBe('missing')
  })
})

describe('the Tailscale probe', () => {
  it('reads ready with the tailnet name through version, status and serve status only', async () => {
    const fake = tailscale()
    expect(await tailscaleReadiness(fake.run)).toEqual({ state: 'ready', dnsName: HOST })
    expect(fake.calls).toEqual([['version'], ['status', '--json'], ['serve', 'status', '--json']])
    expect(fake.calls.flat()).not.toContain('sudo')
  })

  it.each<readonly [string, Parameters<typeof tailscale>[0], string]>([
    ['is not installed', { version: { code: null, stdout: '', stderr: '' } }, 'not-installed'],
    ['is signed out', { status: ok(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' }, CertDomains: [] })) }, 'signed-out'],
    ['has HTTPS off', { status: ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [] })) }, 'https-off'],
    ['needs the operator setting', { serve: { code: 1, stdout: '', stderr: 'Access denied: serve config denied' } }, 'needs-operator'],
  ])('stops at the first thing missing when Tailscale %s', async (_, answers, state) => {
    expect(await tailscaleReadiness(tailscale(answers).run)).toEqual({ state })
  })

  it('reads unknown for a failure it cannot place', async () => {
    expect(await tailscaleReadiness(async () => { throw new Error('spawn failed') })).toEqual({ state: 'unknown' })
  })

  it('reads unknown for a refusal that is for reach on to name', async () => {
    const { ReachError } = await import('@delorun/reach')
    expect(await tailscaleReadiness(async () => { throw new ReachError('TAILSCALE_SERVE_CONFLICT', 'conflict') })).toEqual({ state: 'unknown' })
  })

  it('reads every probe at once', async () => {
    await place('.codex/auth.json')
    expect(await readReadiness(environment())).toEqual({ agents: { 'claude-code': 'missing', 'codex': 'found' }, tailscale: { state: 'ready', dnsName: HOST } })
  })

  it('reads this process\'s environment', () => {
    const run = tailscale().run
    expect(processReadinessEnvironment(run)).toMatchObject({ env: process.env, platform: process.platform, tailscale: run })
  })
})

describe('the stored account figures', () => {
  const account = { provider: 'claude-code', installed: true, signedIn: 'yes', plan: 'max', windows: [], checkedAt: 1 } as const

  it('are read as stored with the time, and a readiness request never asks for a check', async () => {
    const read = vi.fn(() => Promise.resolve([account]))
    const answer = await readReadiness(environment({ accounts: read, now: () => 42 }))
    expect(answer.accounts).toEqual({ agents: [account], now: 42 })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('are left out when the profile has no store or the store cannot be read', async () => {
    expect((await readReadiness(environment())).accounts).toBeUndefined()
    expect((await readReadiness(environment({ accounts: () => Promise.reject(new Error('unreadable')) }))).accounts).toBeUndefined()
  })
})
