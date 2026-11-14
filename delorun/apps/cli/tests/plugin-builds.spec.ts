/**
 * Build-script approval for `delorun plugin` (`delorun/apps/cli/src/plugin-builds.ts`): `--allow-build` is taken out of
 * the arguments before `--` and refuses wildcards and denials; pnpm's output is kept for installing commands only; a
 * failed operation's output is read for the builds pnpm refused, each is recorded as undecided in the profile's
 * `pnpm-workspace.yaml`, and only the one the person allows, at the prompt or by name, is written as allowed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CliError, EXIT } from '../src/exit.ts'
import { buildQuestion, capturesOutput, capturingPackageManager, decideBuilds, namesKey, packageNameOf, takeAllowBuild, takeCapture } from '../src/plugin-builds.ts'

/** The key pnpm prints for a git-hosted package it refused to prepare. */
const GIT_KEY = 'git-plug@git+file:///tmp/repo#8edca4e355d5677de0397415bf6ea4a7307bb076'

/** pnpm's refusal of a git-hosted package's prepare script, as pnpm 11 prints it. */
const GIT_REFUSAL = [
  '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "file:///tmp/repo": The git-hosted package "git-plug@0.1.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.',
  '',
  'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
  'allowBuilds:',
  `  ${GIT_KEY}: true`,
  '',
].join('\n')

let profileDir: string

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'delorun-plugin-builds-'))
  writeFileSync(join(profileDir, 'package.json'), '{"name":"dsh-profile-default","private":true,"dependencies":{}}\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\n')
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

/**
 * The profile's `allowBuilds`.
 * @returns the mapping.
 */
function allowBuilds(): unknown {
  return (parse(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')) as { allowBuilds?: unknown }).allowBuilds
}

describe('--allow-build', () => {
  it('is taken out of the arguments before --, in both spellings', () => {
    expect(takeAllowBuild(['add', 'github:me/plug', '--allow-build', 'plug', '--allow-build=other', '--', '--allow-build', 'x'])).toEqual({
      args: ['add', 'github:me/plug', '--', '--allow-build', 'x'],
      allowed: ['plug', 'other'],
    })
  })

  it.each([['--allow-build'], ['--allow-build', ''], ['--allow-build', '--save-dev'], ['--allow-build', '*'], ['--allow-build=esb?ild'], ['--allow-build', '!plug']])('refuses %j as a usage error', (...args) => {
    expect(() => takeAllowBuild(['add', 'x', ...args])).toThrow(CliError)
    try {
      takeAllowBuild(['add', 'x', ...args])
    } catch (error) {
      expect((error as CliError).exit).toBe(EXIT.usage)
    }
  })

  it('names a key by the package name, or by the whole key', () => {
    expect(namesKey(GIT_KEY, 'git-plug')).toBe(true)
    expect(namesKey(GIT_KEY, GIT_KEY)).toBe(true)
    expect(namesKey(GIT_KEY, 'git')).toBe(false)
    expect(namesKey('@me/plug@git+https://example.test/me/plug#abc', '@me/plug')).toBe(true)
    expect(packageNameOf('@me/plug@git+ssh://git@example.test/me/plug')).toBe('@me/plug')
    expect(packageNameOf('esbuild')).toBe('esbuild')
  })
})

describe('after a failed operation', () => {
  it('records nothing and allows nothing when pnpm refused no build', async () => {
    expect(await decideBuilds({ profileDir, output: 'ERR_PNPM_FETCH_404 nothing here\n', allowed: [], confirm: undefined, stderr: () => undefined })).toEqual({ allowed: [], undecided: [] })
    expect(allowBuilds()).toBeUndefined()
  })

  it('allows the refused build the person allows at the prompt, after saying what allowing it means', async () => {
    const questions: string[] = []
    const decision = await decideBuilds({ profileDir, output: GIT_REFUSAL, allowed: [], confirm: (question) => { questions.push(question); return Promise.resolve(true) }, stderr: () => undefined })
    expect(decision).toEqual({ allowed: [GIT_KEY], undecided: [] })
    expect(questions).toEqual([buildQuestion(GIT_KEY)])
    expect(questions[0]).toContain('outside the sandbox')
    expect(allowBuilds()).toEqual({ [GIT_KEY]: true })
  })

  it('leaves a build the person declines undecided and says how to allow that one package', async () => {
    const lines: string[] = []
    const decision = await decideBuilds({ profileDir, output: GIT_REFUSAL, allowed: [], confirm: () => Promise.resolve(false), stderr: (text) => { lines.push(text) } })
    expect(decision).toEqual({ allowed: [], undecided: [GIT_KEY] })
    expect(allowBuilds()).toEqual({ [GIT_KEY]: 'set this to true or false' })
    expect(lines.join('')).toContain('--allow-build git-plug')
  })

  it('allows only the build --allow-build names, without a terminal', async () => {
    const decision = await decideBuilds({ profileDir, output: `${GIT_REFUSAL}\nIgnored build scripts: esbuild, sharp\n`, allowed: ['git-plug'], confirm: undefined, stderr: () => undefined })
    expect(decision).toEqual({ allowed: [GIT_KEY], undecided: ['esbuild', 'sharp'] })
    expect(allowBuilds()).toEqual({ [GIT_KEY]: true, esbuild: 'set this to true or false', sharp: 'set this to true or false' })
  })
})

describe('pnpm\'s output', () => {
  it('is kept for installing commands that are not interactive', () => {
    expect(capturesOutput(['--profile', 'default', 'add', 'x'])).toBe(true)
    expect(capturesOutput(['install'])).toBe(true)
    expect(capturesOutput(['--profile', 'add', 'list'])).toBe(false)
    expect(capturesOutput(['update', '--interactive'])).toBe(false)
    expect(capturesOutput(['up', '-i'])).toBe(false)
    expect(capturesOutput(['list'])).toBe(false)
    expect(capturesOutput(['--save-dev'])).toBe(false)
  })

  it('is kept by a wrapper that runs the real pnpm with its arguments and environment', () => {
    const real = { command: '/opt/node', args: ['/opt/pnpm.cjs'], env: { PATH: '/opt' } }
    const wrapped = capturingPackageManager(real, '/run/out.log')
    expect(wrapped.command).toBe(process.execPath)
    expect(wrapped.args.slice(0, 1)).toEqual(['-e'])
    expect(wrapped.args.slice(2)).toEqual(['/run/out.log', '/opt/node', '/opt/pnpm.cjs'])
    expect(wrapped.env).toEqual({ PATH: '/opt' })
    expect(capturingPackageManager(undefined, '/run/out.log').args.slice(2)).toEqual(['/run/out.log', 'pnpm'])
  })

  it('is read back once, and an absent copy reads as nothing', async () => {
    const file = join(profileDir, 'out.log')
    writeFileSync(file, GIT_REFUSAL)
    expect(await takeCapture(file)).toBe(GIT_REFUSAL)
    expect(await takeCapture(file)).toBe('')
  })
})
