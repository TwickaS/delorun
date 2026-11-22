import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOME_SOURCE_ENV, HomeSourceError, parseHomeSource, readHomeSourceSetting, resolveHomeSource } from '../src/home-source.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function userData(settings?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'home-source-'))
  directories.push(directory)
  if (settings !== undefined) {
    mkdirSync(join(directory, 'desktop'), { recursive: true })
    writeFileSync(join(directory, 'desktop', 'settings.json'), JSON.stringify(settings))
  }
  return directory
}

describe('parseHomeSource', () => {
  it('reads the three forms', () => {
    expect(parseHomeSource(undefined)).toBeUndefined()
    expect(parseHomeSource('')).toBeUndefined()
    expect(parseHomeSource('bundled')).toEqual({ kind: 'bundled' })
    expect(parseHomeSource('wsl:Ubuntu')).toEqual({ kind: 'wsl', distro: 'Ubuntu', profile: 'default' })
    expect(parseHomeSource('wsl:Ubuntu-24.04:work')).toEqual({ kind: 'wsl', distro: 'Ubuntu-24.04', profile: 'work' })
  })

  it.each([
    'wsl', 'wsl:', 'wsl:-d', 'wsl:Ubuntu:', 'wsl:Ubuntu:a:b', 'wsl:Ubuntu:-x', 'wsl:Ubuntu:a b', 'remote:host', 'Bundled',
    'wsl:Ubu"ntu', 'wsl:Ubuntu 22', 'wsl:Ub$(id)', 'wsl:Ubuntu;x', 'wsl:.hidden', 'wsl:Ubuntu:a;b', 'wsl:Ubuntu:a"b',
    `wsl:${'u'.repeat(65)}`, `wsl:Ubuntu:${'x'.repeat(65)}`,
  ])('refuses %j', (value) => {
    expect(() => parseHomeSource(value)).toThrow(HomeSourceError)
  })
})

describe('home source setting', () => {
  it('reads a WSL source from the settings file', async () => {
    expect(await readHomeSourceSetting(userData({ homeSource: { kind: 'wsl', distro: 'Debian' } }))).toEqual({ kind: 'wsl', distro: 'Debian', profile: 'default' })
  })

  it('selects nothing without a file or a field, and refuses a field written wrongly', async () => {
    expect(await readHomeSourceSetting(userData())).toBeUndefined()
    expect(await readHomeSourceSetting(userData({ updates: {} }))).toBeUndefined()
    await expect(readHomeSourceSetting(userData({ homeSource: { kind: 'wsl' } }))).rejects.toThrow(HomeSourceError)
    await expect(readHomeSourceSetting(userData({ homeSource: { kind: 'wsl', distro: '--shutdown' } }))).rejects.toThrow(HomeSourceError)
    await expect(readHomeSourceSetting(userData({ homeSource: { kind: 'wsl', distro: 'Ubuntu 22' } }))).rejects.toThrow(HomeSourceError)
    await expect(readHomeSourceSetting(userData({ homeSource: { kind: 'wsl', distro: 'Ubuntu', profile: 'a"b' } }))).rejects.toThrow(HomeSourceError)
  })

  it('lets the environment variable win over the setting, and falls back to the bundled Host', async () => {
    const data = userData({ homeSource: { kind: 'wsl', distro: 'Debian' } })
    expect(await resolveHomeSource({ [HOME_SOURCE_ENV]: 'bundled' }, data)).toEqual({ kind: 'bundled' })
    expect(await resolveHomeSource({}, data)).toEqual({ kind: 'wsl', distro: 'Debian', profile: 'default' })
    expect(await resolveHomeSource({}, userData())).toEqual({ kind: 'bundled' })
  })
})
