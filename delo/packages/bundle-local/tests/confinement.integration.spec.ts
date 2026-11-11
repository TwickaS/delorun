/**
 * C1's home protection in the shipped composition: the `sandbox` row of a Delo CLI profile carries the Delo home as
 * `protectedHome` with C1's read exemptions, and upstream's local sandbox provider — configured with that composed row
 * and nothing else — confines a workspace command so it cannot read a canary under `<home>/secrets`, while the same
 * command unconfined reads it and a file under an exemption stays readable.
 *
 * The home sits outside the OS temporary directory, which upstream's profiles replace with a private `/tmp`, so the
 * bwrap dialect's denial is C1's rule and not the private temporary directory's. The bwrap dialect is the one a host
 * without the Landlock launcher runs, and it is skipped where `bwrap` is not usable.
 */
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { LOCAL_ROWS, parityPatches } from '../src/profile.ts'
import { createTestHome, DELO_PROFILE, type TestHome } from './profiles.ts'

/** A base outside the OS temporary directory, where the home's denial is C1's rule rather than a private `/tmp`. */
const BASE = existsSync('/var/tmp') ? '/var/tmp' : undefined

/** Reads one file and prints `ok`, or the error code that stopped it. */
const READ = `try { require('node:fs').readFileSync(process.argv[1]); console.log('ok') } catch (error) { console.log(error.code || 'error') }`

const bwrapUsable = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--', 'true'], { stdio: 'ignore', timeout: 30_000 }).status === 0
const execFileAsync = promisify(execFile)

let home: TestHome
/** The workspace the confined command runs in, outside the protected home the provider refuses to write inside. */
let workspace: string
let ctx: Context | undefined

beforeAll(() => {
  home = createTestHome(BASE)
  workspace = mkdtempSync(join(BASE ?? tmpdir(), 'delo-bundle-local-workspace-'))
})

afterAll(async () => {
  await ctx?.fiber.dispose()
  home.remove()
  rmSync(workspace, { recursive: true, force: true })
})

/**
 * The `sandbox` row of the composed Delo CLI profile, with the bundle's `!!js` values evaluated as the loader
 * evaluates them: `dshHomePath` is the scope the composition reads, and the harness home is the Delo home.
 * @returns the row's config.
 */
function composedSandboxConfig(): { readonly protectedHome: string, readonly protectedHomeReadable: readonly string[], readonly protectedHomeToolReadable: readonly string[] } {
  const row = home.rows(DELO_PROFILE).find(entry => entry.id === 'sandbox')
  if (row?.config === undefined) throw new Error('the composed Delo CLI profile has no configured sandbox row')
  return interpolate({ dshHomePath }, row.config) as { readonly protectedHome: string, readonly protectedHomeReadable: readonly string[], readonly protectedHomeToolReadable: readonly string[] }
}

/**
 * Run one command and read what it printed.
 * @param argv - the command.
 * @returns its standard output, trimmed.
 */
async function run(argv: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(argv[0] ?? '', argv.slice(1), { encoding: 'utf8', timeout: 30_000 })
  return stdout.trim()
}

describe('the shipped composition\'s sandbox row', () => {
  it('protects the Delo home with C1\'s read exemptions, and the parity form leaves the row to upstream', () => {
    // The harness home is the Delo home for every runtime process C1 starts.
    vi.stubEnv('DSH_HOME', home.dir)
    try {
      const config = composedSandboxConfig()
      expect(config).toEqual({ protectedHome: home.dir, protectedHomeReadable: [...READ_EXEMPTIONS], protectedHomeToolReadable: ['spill'] })
    } finally {
      vi.unstubAllEnvs()
    }
    // The replay runs upstream's confinement: no patch of the row reaches the parity composition.
    expect(LOCAL_ROWS.find(row => row.id === 'sandbox')?.parity.kind).toBe('upstream')
    const patches = parityPatches([{ id: 'sandbox', config: { protectedHome: '/fixture' } }])
    expect(patches).toEqual([])
  })
})

describe('a confined command under the shipped composition\'s sandbox row', () => {
  it.skipIf(!bwrapUsable)('cannot read a canary under the home\'s secrets, and reads a file under an exemption', { timeout: 60_000 }, async () => {
    // C1's protected parsing state: the stores of the MCP add-time and permission consents live under `secrets/`.
    const secrets = join(home.dir, 'secrets')
    mkdirSync(secrets, { recursive: true })
    const canary = join(secrets, 'canary')
    writeFileSync(canary, 'canary\n', { mode: 0o600 })
    // An exemption the runtime needs, which must stay readable: it holds no secret.
    const exemption = join(home.dir, 'runtimes', 'probe')
    mkdirSync(join(home.dir, 'runtimes'), { recursive: true })
    writeFileSync(join(home.dir, 'runtimes', 'probe'), 'probe\n', { mode: 0o644 })

    vi.stubEnv('DSH_HOME', home.dir)
    try {
      ctx = new Context()
      await ctx.plugin(LocalSandboxProvider, composedSandboxConfig() as { protectedHome: string, protectedHomeReadable: string[], protectedHomeToolReadable: string[] })
    } finally {
      vi.unstubAllEnvs()
    }
    const sandbox = ctx.sandbox as LocalSandboxProvider
    // The dialect this host's lane runs: bwrap, with Landlock's probe off so the chain selects it.
    sandbox.internals = { probeLandlock: () => 'unusable' }
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
    const confined = await sandbox.confine([process.execPath, '-e', READ, canary], policy)
    // Where the kernel offers vsock, bwrap is started from the shell that hands it the seccomp filter.
    expect(confined.argv).toContain('bwrap')

    // The confinement, not the host, denies the canary: the same command unconfined reads it.
    expect(await run([process.execPath, '-e', READ, canary])).toBe('ok')
    expect(await run(confined.argv)).not.toBe('ok')
    // The read exemptions still reach a confined command, so a runtime or skill directory keeps working.
    const readable = await sandbox.confine([process.execPath, '-e', READ, exemption], policy)
    expect(await run(readable.argv)).toBe('ok')
    // Spilled tool output is readable by the read tools only: a confined command cannot read it.
    mkdirSync(join(home.dir, 'spill'), { recursive: true })
    const spilled = join(home.dir, 'spill', 'canary')
    writeFileSync(spilled, 'canary\n', { mode: 0o600 })
    expect(sandbox.protectedReads?.toolReadable).toContain(join(home.dir, 'spill'))
    expect(await run((await sandbox.confine([process.execPath, '-e', READ, spilled], policy)).argv)).not.toBe('ok')
  })
})
