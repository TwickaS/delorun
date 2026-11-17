import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { childEnv, Config, installedPackageDirectory, NEVER_INHERITED, resolveCommand, validateConfig, variantOf } from '../src/config.ts'

describe('the browse row configuration', () => {
  it('defaults to the pinned binary for this computer, run as `browse mcp`, with nothing inherited', () => {
    expect(Config({})).toEqual({ variant: 'auto', args: ['mcp'], inheritEnv: [], awayDays: 7 })
    expect(() => Config({ awayDays: 0 })).toThrow()
    expect(() => Config({ awayDays: 31 })).toThrow()
  })

  it('refuses a relative command and every variable Delorun never passes on', () => {
    expect(() => { validateConfig(Config({ command: 'browse' })) }).toThrow(/absolute path/u)
    for (const name of NEVER_INHERITED) {
      expect(() => { validateConfig(Config({ inheritEnv: [name] })) }, name).toThrow(new RegExp(`OPENCODE_BROWSER_${name}`, 'u'))
    }
    expect(() => { validateConfig(Config({ inheritEnv: ['DEBUG'] })) }).not.toThrow()
    expect(() => Config({ inheritEnv: ['lower case'] })).toThrow()
  })

  it('never lets an inherited escape hatch reach the server, blanks every other browse variable, and turns updates off', () => {
    const env: Record<string, string> = {
      OPENCODE_BROWSER_ALLOW_ALL_COOKIES: '1',
      OPENCODE_BROWSER_ALLOW_ALL_STORAGE: '1',
      OPENCODE_BROWSER_ALLOW_FILE_URLS: '1',
      OPENCODE_BROWSER_ALLOW_FOREGROUND: '1',
      OPENCODE_BROWSER_FILE_ROOTS: '/',
      OPENCODE_BROWSER_TOOLS: 'plain',
      OPENCODE_BROWSER_AUTO_UPDATE: 'on',
      opencode_browser_allow_all_cookies: '1',
      OPENCODE_BROWSER_DEBUG: '1',
      PATH: '/bin',
    }
    // Pins the denial: even a row that tried to list the hatches (the schema check is bypassed here) passes none of them on.
    const merged: Record<string, string | undefined> = { ...env, ...childEnv({ inheritEnv: ['ALLOW_ALL_COOKIES', 'FILE_ROOTS', 'DEBUG'] }, env) }
    for (const name of ['ALLOW_ALL_COOKIES', 'ALLOW_ALL_STORAGE', 'ALLOW_FILE_URLS', 'ALLOW_FOREGROUND', 'FILE_ROOTS', 'TOOLS']) {
      expect(merged[`OPENCODE_BROWSER_${name}`], name).toBe('')
    }
    expect(merged['opencode_browser_allow_all_cookies']).toBe('')
    expect(merged['OPENCODE_BROWSER_AUTO_UPDATE']).toBe('off')
    expect(merged['OPENCODE_BROWSER_UPDATE_CHECK']).toBe('0')
    expect(merged['OPENCODE_BROWSER_DEBUG']).toBe('1')
    expect(merged['PATH']).toBe('/bin')
    expect(childEnv({ inheritEnv: [] }, env)['OPENCODE_BROWSER_DEBUG']).toBe('')
  })

  it('picks the platform package for each computer, and none for Windows on ARM', () => {
    expect(variantOf({ platform: 'linux', arch: 'x64', musl: false })).toBe('linux-x64')
    expect(variantOf({ platform: 'linux', arch: 'arm64', musl: true })).toBe('linux-arm64-musl')
    expect(variantOf({ platform: 'darwin', arch: 'arm64', musl: false })).toBe('darwin-arm64')
    expect(variantOf({ platform: 'win32', arch: 'x64', musl: false })).toBe('windows-x64')
    expect(variantOf({ platform: 'win32', arch: 'arm64', musl: false })).toBeUndefined()
    expect(variantOf({ platform: 'freebsd', arch: 'x64', musl: false })).toBeUndefined()
  })

  it('resolves the pinned binary, and fails loud for a missing variant, package or binary', () => {
    const root = mkdtempSync(join(tmpdir(), 'realb-config-'))
    const linux = join(root, 'linux-x64')
    mkdirSync(join(linux, 'bin'), { recursive: true })
    writeFileSync(join(linux, 'bin', 'browse'), '')
    const host = { platform: 'linux', arch: 'x64', musl: false } as const
    expect(resolveCommand(Config({}), host, variant => (variant === 'linux-x64' ? linux : undefined))).toEqual({ command: join(linux, 'bin', 'browse'), args: ['mcp'] })
    expect(() => resolveCommand(Config({}), { platform: 'win32', arch: 'arm64', musl: false }, () => linux)).toThrow(/no build for win32 on arm64/u)
    expect(() => resolveCommand(Config({ variant: 'windows-x64' }), host, () => undefined)).toThrow(/windows-x64 is not installed/u)
    expect(() => resolveCommand(Config({ variant: 'windows-x64' }), host, () => linux)).toThrow(/binary for windows-x64 is missing/u)
    expect(resolveCommand(Config({ command: '/opt/fixture', args: ['serve'] }), host, () => undefined)).toEqual({ command: '/opt/fixture', args: ['serve'] })
  })

  it('finds no platform package where the browse launcher is not installed', () => {
    // The browse pack installs the launcher and its platform packages; this workspace installs neither.
    expect(installedPackageDirectory('linux-x64')).toBeUndefined()
    expect(installedPackageDirectory('windows-x64')).toBeUndefined()
  })
})
