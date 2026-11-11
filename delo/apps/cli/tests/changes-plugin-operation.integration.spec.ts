/**
 * The plugin operation `delorun changes apply` runs for an agent's plugin request: `@delo/changes`' shared operation
 * from the command's directory, its output on the command's streams, with this installation's anchor. The denial cases
 * apply a held request through `applyInstallChange` with upstream's real operation and pnpm.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyInstallChange, attestTerminal, ChangesError, readChangeLog, recordPluginRequest, type ChangesContext } from '@delo/changes'
import type { PackageOperationContext, PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import { loadUpstream, upstreamPluginOperation, type UpstreamOperation } from '../src/changes/plugin-operation.ts'

// Loading upstream's profile boot module and running pnpm take several seconds under a loaded host.
vi.setConfig({ testTimeout: 120_000 })

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A Delo home whose profile `default` has a manifest with the given dependencies.
 * @param dependencies - the profile's dependencies.
 * @returns the root and the profile's context.
 */
function profile(dependencies: Record<string, string> = {}): { readonly root: string, readonly ctx: ChangesContext } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-plugin-operation-')))
  roots.push(root)
  const home = join(root, '.delo')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies, dsh: { profile: { bundles: [] } } }, undefined, 2)}\n`)
  return { root, ctx: { home, profile: 'default', profileDir } }
}

/**
 * @param dir - a directory.
 * @param manifest - its `package.json`.
 * @returns the directory.
 */
function packageAt(dir: string, manifest: object): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

/**
 * Upstream with a stubbed `runProfilePnpm` that sets the profile's dependencies, and stubbed checks.
 * @param ctx - the profile.
 * @param result - what the run reports, and the dependencies it leaves.
 * @param checks - the checks' answers.
 * @returns the upstream loader and the stub.
 */
function stubbed(ctx: ChangesContext, result: { readonly exitCode?: number, readonly dependencies?: Record<string, string>, readonly incompatible?: { name: string, version: string }[] } = {}, checks: Partial<Pick<UpstreamOperation, 'bundleManifest' | 'incompatibility'>> = {}) {
  const runProfilePnpm = vi.fn(async (_context: PackageOperationContext, _args: readonly string[], options: PackageOperationOptions) => {
    options.onOutput?.('added 1\n', 'stdout')
    options.onOutput?.('warning\n', 'stderr')
    if (result.dependencies !== undefined) writeFileSync(join(ctx.profileDir, 'package.json'), JSON.stringify({ dependencies: result.dependencies }))
    return { exitCode: result.exitCode ?? 0, logPath: '/l', output: 'out', ...result.incompatible === undefined ? {} : { incompatible: result.incompatible } }
  })
  const upstream: UpstreamOperation = {
    installAnchor: '/anchor',
    runProfilePnpm,
    bundleManifest: checks.bundleManifest ?? (() => ({ dsh: { bundle: { patch: 'cordis.patch.yml' } } })),
    incompatibility: checks.incompatibility ?? (() => undefined),
  }
  return { load: async () => upstream, runProfilePnpm }
}

const QUIET = { stdout: () => {}, stderr: () => {} }

describe('upstreamPluginOperation', () => {
  it('runs @delo/changes\' shared operation from the command\'s directory and prints its output on the command\'s streams', async () => {
    const { ctx } = profile()
    const printed: string[] = []
    const errors: string[] = []
    const { load, runProfilePnpm } = stubbed(ctx, { dependencies: { x: '1.0.0' } })
    const run = upstreamPluginOperation(ctx, { stdout: text => void printed.push(text), stderr: text => void errors.push(text) }, load)
    expect(await run(['add', 'x@1'])).toEqual({ exitCode: 0, logPath: '/l', output: 'out' })
    expect(runProfilePnpm).toHaveBeenCalledWith(
      { profile: 'default', dir: ctx.profileDir, installAnchor: '/anchor', cwd: process.cwd(), home: ctx.home },
      ['add', 'x@1'],
      expect.objectContaining({ execution: 'service', outputBytes: 16_384, lookupTimeoutMs: 120_000 }),
    )
    expect(printed).toEqual(['added 1\n'])
    expect(errors).toEqual(['warning\n'])
    // The shared operation's checks run here too.
    const plain = stubbed(ctx, { dependencies: { x: '1.0.0', plain: '1.0.0' } }, { bundleManifest: () => undefined })
    expect(await upstreamPluginOperation(ctx, QUIET, plain.load)(['add', 'plain'])).toMatchObject({ exitCode: 1, failure: 'plain is no DSH plugin bundle: its package.json declares no dsh.bundle.patch, so nothing was installed' })
  })

  it('loads upstream\'s operation, checks and this installation\'s anchor by default', async () => {
    const upstream = await loadUpstream()
    const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
    expect(upstream.installAnchor).toBe(INSTALL_ANCHOR)
    expect(typeof upstream.runProfilePnpm).toBe('function')
    expect(upstream.incompatibility({ name: 'p', version: '1.0.0' }, '/nonexistent')).toBeUndefined()
    // The default loader is the one the operation uses when none is given.
    expect(upstreamPluginOperation({ home: '/h', profile: 'default', profileDir: '/h/p' }, QUIET)).toBeTypeOf('function')
  })
})

describe('applying the agent\'s held plugin request with upstream\'s operation', () => {
  /**
   * Apply a request with upstream's real operation.
   * @param ctx - the profile.
   * @param spec - the spec the agent asked for.
   * @returns the request's id and the failure the apply threw.
   */
  async function applyHeld(ctx: ChangesContext, spec: string): Promise<{ readonly id: string, readonly error: unknown }> {
    const request = await recordPluginRequest(ctx, { action: 'install', spec })
    const presence = attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
    const error = await applyInstallChange(ctx, request.id, presence, { reload: async () => undefined, run: upstreamPluginOperation(ctx, QUIET) }).then(() => undefined, (failure: unknown) => failure)
    return { id: request.id, error }
  }

  it('applying a held install keeps install scripts held back as stock does', async () => {
    const { root, ctx } = profile()
    // pnpm's own setting for build scripts nobody decided: fail rather than skip them, as pnpm 11 does by default.
    writeFileSync(join(ctx.profileDir, 'pnpm-workspace.yaml'), `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\nstoreDir: ${join(root, 'store')}\n`)
    const manifest = readFileSync(join(ctx.profileDir, 'package.json'), 'utf8')
    const marker = join(root, 'script-ran')
    const scripted = packageAt(join(root, 'scripted'), {
      name: 'scripted', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
      scripts: { postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` },
    })
    execFileSync('pnpm', ['pack', '--pack-destination', root], { cwd: scripted, stdio: 'ignore', timeout: 60_000 })
    const tarball = join(root, 'scripted-1.0.0.tgz')

    const { id, error } = await applyHeld(ctx, tarball)
    expect(error).toBeInstanceOf(ChangesError)
    expect((error as ChangesError).code).toBe('OPERATION_FAILED')
    // The script never ran, nothing allowed it, and the profile names no new dependency.
    expect(existsSync(marker)).toBe(false)
    const workspace = readFileSync(join(ctx.profileDir, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toMatch(/allowBuilds:\n {2}scripted@file:\S+: set this to true or false\n/)
    expect(workspace).not.toMatch(/^ {2}\S+: true$/m)
    expect(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8')).toBe(manifest)
    expect(existsSync(join(ctx.profileDir, 'pnpm-lock.yaml'))).toBe(false)
    const entry = (await readChangeLog(ctx.home, ctx.profile)).entries.find(candidate => candidate.id === id)
    expect(entry?.state).toBe('pending')
    expect(entry?.lastFailure?.failure).toMatch(/nothing was installed, and pnpm holds back the build scripts of scripted@file:\S+ until you decide under allowBuilds in .+pnpm-workspace\.yaml: true lets one run, false installs without it$/)
  })

  it('applying a held install refuses a version incompatible with this Delo', async () => {
    vi.stubEnv('DELO_VERSION', '0.1.0')
    const { root, ctx } = profile()
    const manifest = readFileSync(join(ctx.profileDir, 'package.json'), 'utf8')
    const folder = packageAt(join(root, 'plug'), { name: 'plug', version: '1.0.0', engines: { delo: '>=99.0.0' }, dsh: { bundle: { patch: 'cordis.patch.yml' } } })

    const { id, error } = await applyHeld(ctx, `link:${folder}`)
    expect((error as ChangesError).code).toBe('OPERATION_FAILED')
    expect((error as ChangesError).message).toContain('plug@1.0.0 requires Delo >=99.0.0; this is Delo 0.1.0')
    expect((error as ChangesError).message).toContain('Nothing was installed.')
    expect(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8')).toBe(manifest)
    expect(existsSync(join(ctx.profileDir, 'node_modules', 'plug'))).toBe(false)
    expect((await readChangeLog(ctx.home, ctx.profile)).entries.find(candidate => candidate.id === id)?.state).toBe('pending')
  })
})
