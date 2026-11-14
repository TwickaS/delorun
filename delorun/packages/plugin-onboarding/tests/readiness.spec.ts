/**
 * What onboarding reads about this computer: sign-ins by whether a file exists, never its contents, and how far
 * Tailscale is from serving the studio, through `tailscale` commands that only read.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TailscaleResult, TailscaleRunner } from '@delorun/reach'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeSignIn, codexSignIn, processReadinessEnvironment, readReadiness, tailscaleReadiness, type ReadinessEnvironment } from '../src/readiness.ts'
import { folderKind } from '../src/folder-kind.ts'

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

describe('what a folder holds', () => {
  it.each<readonly [string, readonly string[], string]>([
    ['nothing visible', ['.DS_Store'], 'empty'],
    ['a Git directory', ['.git'], 'code'],
    ['a manifest', ['package.json', 'README.md'], 'code'],
    ['a .NET project', ['App.csproj'], 'code'],
    ['a .NET solution', ['App.sln'], 'code'],
    ['documents', ['notes.md', 'photo.jpg'], 'files'],
  ])('reads %s as %s', async (_, names, kind) => {
    const folder = join(home, 'folder')
    await mkdir(folder)
    for (const name of names) await (name === '.git' ? mkdir(join(folder, name)) : writeFile(join(folder, name), ''))
    expect(await folderKind(folder)).toBe(kind)
  })

  it('reads an empty folder as empty and one it cannot list as files', async () => {
    await mkdir(join(home, 'empty'))
    expect(await folderKind(join(home, 'empty'))).toBe('empty')
    expect(await folderKind(join(home, 'missing'))).toBe('files')
  })

  it('stops reading a huge folder after the first entries', async () => {
    const folder = join(home, 'huge')
    await mkdir(folder)
    await Promise.all(Array.from({ length: 2100 }, (_, index) => writeFile(join(folder, `f${String(index)}.txt`), '')))
    expect(await folderKind(folder)).toBe('files')
  })
})
