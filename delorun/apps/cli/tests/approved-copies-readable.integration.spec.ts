/**
 * `approved-plugin-copies-readable`: a command confined by the sandbox Delorun's start configures reads, and runs a
 * script in, the profile's approved plugin copies (`changes/profiles/<profile>/active`), so a plugin can hand an agent
 * the path of its own tool. Nothing else under `changes/` opens with it: not another profile's approved copies, not the
 * store that holds pending and unapproved content, not the records beside `active/`, and not the rest of the home. A
 * confined write into an approved copy is refused. Each case runs on bwrap, where this machine has it.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { activeCopiesEntry } from '@delorun/changes'
import { sandboxProtection } from '../src/sandbox-protection.ts'

const bwrapUsable = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--', 'true'], { timeout: 5_000, stdio: 'ignore' }).status === 0

let base: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (base !== undefined) rmSync(base, { recursive: true, force: true })
  base = undefined
})

/** The files the cases look for, by what they stand for. */
interface Fixture {
  readonly home: string
  readonly workspace: string
  readonly files: Readonly<Record<'active' | 'script' | 'otherProfile' | 'pending' | 'store' | 'record' | 'secret', string>>
  readonly confine: (argv: readonly string[]) => Promise<string[]>
}

/**
 * A home with the files, and the provider as Delorun's start configures it for the `default` profile.
 * @returns the fixture.
 */
async function setUp(): Promise<Fixture> {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-copies-')))
  const home = join(base, 'home')
  const workspace = join(base, 'workspace')
  const files = {
    active: join(home, 'changes', 'profiles', 'default', 'active', 'example-plugin', 'tool.txt'),
    script: join(home, 'changes', 'profiles', 'default', 'active', 'example-plugin', 'tool.sh'),
    otherProfile: join(home, 'changes', 'profiles', 'other', 'active', 'example-plugin', 'tool.txt'),
    pending: join(home, 'changes', 'profiles', 'default', 'pending', 'example-plugin', 'tool.txt'),
    store: join(home, 'changes', 'store', 'objects', 'a'.repeat(64)),
    record: join(home, 'changes', 'profiles', 'default', 'active.json'),
    secret: join(home, 'secrets', 'canary'),
  } as const
  for (const file of Object.values(files)) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'visible\n')
  }
  writeFileSync(files.script, '#!/bin/sh\necho ran\n')
  chmodSync(files.script, 0o755)
  mkdirSync(join(home, 'run', 'default'), { recursive: true })
  mkdirSync(workspace)
  const protection = await sandboxProtection(home, 'default', { DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONFIG: join(base, 'no-config') }, join(base, 'os-home'), process.getuid?.())
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {
    protectedHome: protection.protectedHome,
    protectedHomeReadable: [...protection.protectedHomeReadable],
    deniedSockets: [...protection.deniedSockets],
    escapeSocketDirectories: [...protection.escapeSocketDirectories],
    privateTmp: protection.privateTmp,
  })
  const sandbox = ctx.sandbox as LocalSandboxProvider
  return { home, workspace, files, confine: async argv => (await sandbox.confine(['sh', '-c', `echo started; ${argv.join(' ')}`], { mode: 'workspace-write', workspaceRoot: workspace })).argv }
}

/**
 * Run a shell command confined.
 * @param fixture - the fixture.
 * @param command - the shell command.
 * @returns the exit status and the output after the start line.
 */
async function confined(fixture: Fixture, command: string): Promise<{ readonly status: number | null, readonly stdout: string }> {
  const argv = await fixture.confine([command])
  const result = spawnSync(argv[0] as string, argv.slice(1), { encoding: 'utf8', timeout: 60_000, cwd: fixture.workspace })
  expect(result.stdout.startsWith('started\n'), `the sandbox did not start the command: ${result.stderr}`).toBe(true)
  return { status: result.status, stdout: result.stdout.slice('started\n'.length) }
}

// Landlock is not exercised here: it grants the copy's real path read-only, which upstream's protected-home.spec.ts covers
// (packages/sandbox/sandbox-local/src/profiles.ts:335).
describe.skipIf(!bwrapUsable)('approved-plugin-copies-readable under bwrap', { timeout: 120_000 }, () => {
  it('names only the profile\'s approved copies', async () => {
    expect(activeCopiesEntry('default')).toBe(join('changes', 'profiles', 'default', 'active'))
  })

  it('reads a file in an approved copy and runs a script in it', async () => {
    const fixture = await setUp()
    expect(await confined(fixture, `cat '${fixture.files.active}'`)).toEqual({ status: 0, stdout: 'visible\n' })
    expect(await confined(fixture, `'${fixture.files.script}'`)).toEqual({ status: 0, stdout: 'ran\n' })
  })

  it('refuses a write into an approved copy, and leaves its files as they were', async () => {
    const fixture = await setUp()
    for (const command of [`echo changed > '${fixture.files.active}'`, `echo new > '${join(fixture.files.active, '..', 'new.txt')}'`, `rm '${fixture.files.active}'`]) {
      expect((await confined(fixture, command)).status, command).not.toBe(0)
    }
    expect(readFileSync(fixture.files.active, 'utf8')).toBe('visible\n')
    expect(existsSync(join(fixture.files.active, '..', 'new.txt'))).toBe(false)
  })

  it('reads nothing else under changes/ and nothing else in the home', async () => {
    const fixture = await setUp()
    for (const name of ['otherProfile', 'pending', 'store', 'record', 'secret'] as const) {
      const result = await confined(fixture, `cat '${fixture.files[name]}'`)
      expect(result.status, name).not.toBe(0)
      expect(result.stdout, name).toBe('')
    }
    expect((await confined(fixture, `ls '${join(fixture.home, 'changes')}'`)).stdout).toBe('profiles\n')
    expect((await confined(fixture, `ls '${join(fixture.home, 'changes', 'profiles')}'`)).stdout).toBe('default\n')
    expect((await confined(fixture, `ls '${join(fixture.home, 'changes', 'profiles', 'default')}'`)).stdout).toBe('active\n')
  })
})
