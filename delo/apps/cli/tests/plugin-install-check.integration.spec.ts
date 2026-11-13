/**
 * The install check where `delorun` runs it (`delo/apps/cli/src/plugin-install-check.ts`): its settings come from the
 * profile's composed `delo-plugin-install-check` row, its switch turns it off, and settings that do not validate stop
 * the command naming the row; the change check prints a warning for a plugin whose files changed since it was
 * installed and records the result as the profile's trust status, and never stops a start. Also the package import
 * method a profile gets (`delo/apps/cli/src/pnpm-import.ts`).
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPackage, readPluginTrust, recordInstalled } from '@delo/plugin-install-check/check'
import { OLD, settingsFor, startStandIn, writeProfileFiles, type StandIn } from '@delo/plugin-install-check/tests/fixture'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { npmMirrorOf } from '../src/compose.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { patchLayers } from '../src/patch-layers.ts'
import { checkInstalledPlugins, INSTALL_CHECK_ROW, profileCheckSettings, runMirror } from '../src/plugin-install-check.ts'
import { copyImportMigration, ensureCopyImport } from '../src/pnpm-import.ts'

let home: string
let profileDir: string
let standIn: StandIn

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-install-check-')))
  profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'profile', private: true, dsh: { profile: { bundles: [] } } })}\n`)
  standIn = await startStandIn({ advisories: {}, times: { 'good-plugin': { '1.0.0': OLD } } })
})

afterEach(async () => {
  await standIn.close()
  rmSync(home, { recursive: true, force: true })
})

/**
 * Give the profile's own patch the check's row.
 * @param row - the row's fields besides its id and name.
 */
function writeRow(row: string): void {
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- insert:\n    - id: ${INSTALL_CHECK_ROW}\n      name: '@delo/plugin-install-check'\n${row}`)
}

describe('the install check\'s settings', () => {
  it('come from the profile\'s composed row, validated and resolved', () => {
    writeRow('      config:\n        enabled: true\n        minimumAgeHours: 48\n        trustedSources: ["@mine", "github.com/me"]\n')
    const check = profileCheckSettings(home, profileDir, join(home, 'no-installation', 'package.json'))
    expect(check?.settings).toMatchObject({ minimumAgeHours: 48, trustedSources: ['@mine', 'github.com/me'], registry: 'https://registry.npmjs.org/' })
  })

  it('are absent without the row, with the row disabled, and with its switch off', () => {
    expect(profileCheckSettings(home, profileDir, join(home, 'package.json'))).toBeUndefined()
    writeRow('      disabled: true\n      config:\n        enabled: true\n')
    expect(profileCheckSettings(home, profileDir, join(home, 'package.json'))).toBeUndefined()
    writeRow('      config:\n        enabled: false\n')
    expect(profileCheckSettings(home, profileDir, join(home, 'package.json'))).toBeUndefined()
  })

  it('refuse a setting that does not validate, naming the row and the file', () => {
    writeRow('      config:\n        enabled: true\n        registry: http://registry.example.test/\n')
    expect(() => profileCheckSettings(home, profileDir, join(home, 'package.json'))).toThrow(CliError)
    expect(() => profileCheckSettings(home, profileDir, join(home, 'package.json'))).toThrow(/delo-plugin-install-check row of the profile default has settings that do not validate/u)
  })
})

describe('the change check at a start', () => {
  it('prints a warning for a plugin changed since its installation and records it as the trust status', async () => {
    writeRow('      config:\n        enabled: true\n')
    writeProfileFiles(profileDir, [{ name: 'good-plugin', version: '1.0.0', direct: true }])
    const checked = await checkPackage({ profileDir, name: 'good-plugin', allowedAdvisories: [], knownNames: new Set(), registries: [], now: Date.now }, settingsFor(standIn))
    if (checked.kind === 'checked' && checked.pending !== undefined) await recordInstalled(profileDir, checked.pending, { now: Date.now, maxFiles: 1000 })
    appendFileSync(join(profileDir, 'node_modules', 'good-plugin', 'index.js'), 'globalThis.planted = true\n')
    const printed: string[] = []
    const status = await checkInstalledPlugins({ home, profile: 'default', profileDir, installAnchor: join(home, 'package.json'), full: false, output: { stdout: () => undefined, stderr: (text) => { printed.push(text) } } })
    expect(status?.plugins.map(plugin => plugin.state)).toEqual(['changed'])
    expect(printed).toEqual(['delorun: warning: 1 file of the plugin good-plugin in the profile default changed since it was installed, such as node_modules/good-plugin/index.js. If you did not change it, reinstall it with: delorun plugin --profile default add good-plugin@1.0.0\n'])
    expect(await readPluginTrust(profileDir)).toEqual(status)
  })

  it('names the plugins without a record, and stops nothing when the check cannot run', async () => {
    writeRow('      config:\n        enabled: true\n')
    writeProfileFiles(profileDir, [{ name: 'good-plugin', version: '1.0.0', direct: true }])
    const printed: string[] = []
    const output = { stdout: () => undefined, stderr: (text: string) => { printed.push(text) } }
    await checkInstalledPlugins({ home, profile: 'default', profileDir, installAnchor: join(home, 'package.json'), full: true, output })
    expect(printed).toEqual(['delorun: 1 plugin of the profile default (good-plugin) has no install record, so changes to it cannot be detected; reinstalling records it\n'])
    writeRow('      config:\n        enabled: true\n        maxFiles: 0\n')
    printed.length = 0
    expect(await checkInstalledPlugins({ home, profile: 'default', profileDir, installAnchor: join(home, 'package.json'), full: false, output })).toBeUndefined()
    expect(printed[0]).toMatch(/^delorun: warning: the installed plugins of the profile default could not be checked for changes: /u)
  })
})

describe('the package import method', () => {
  it('is set to copies where the profile names none, keeping the file\'s comments, and a person\'s choice stays', async () => {
    const path = join(profileDir, 'pnpm-workspace.yaml')
    expect(await ensureCopyImport(profileDir)).toBe('absent')
    writeFileSync(path, '# pnpm settings\npackages:\n  - .\n')
    expect(await ensureCopyImport(profileDir)).toBe('added')
    expect(readFileSync(path, 'utf8')).toBe('# pnpm settings\npackages:\n  - .\npackageImportMethod: copy\n')
    writeFileSync(path, 'packageImportMethod: hardlink\n')
    expect(await ensureCopyImport(profileDir)).toBe('kept')
    expect(readFileSync(path, 'utf8')).toBe('packageImportMethod: hardlink\n')
  })

  it('is a one-time change that completes once the file exists, and warns about a file that is not a mapping', async () => {
    const printed: string[] = []
    const migration = copyImportMigration(profileDir, { stdout: () => undefined, stderr: (text) => { printed.push(text) } })
    expect(await migration.run()).toBe(false)
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), '- not a mapping\n')
    expect(await migration.run()).toBe(false)
    expect(printed[0]).toMatch(/pnpm-workspace\.yaml is not a YAML mapping/u)
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages: [.]\n')
    expect(await migration.run()).toBe(true)
  })
})

describe('the npm mirror setting', () => {
  it('is written into the profile\'s own patch with the row\'s other settings, and read back by the composition', async () => {
    writeRow('      config:\n        enabled: true\n        minimumAgeHours: 48\n')
    const printed: string[] = []
    expect(runMirror(['on'], { home, profile: 'default', profileDir, installAnchor: join(home, 'package.json'), output: { stdout: (text) => { printed.push(text) }, stderr: () => undefined } })).toBe(0)
    expect(printed[0]).toMatch(/^The npm mirror is on for the profile default: .* It applies from the next start\.\n$/u)
    const profile = loadProfileDirectory('delorun', profileDir, join(home, 'package.json'))
    expect(npmMirrorOf(patchLayers(home, profile, []))).toBe(true)
    expect(profileCheckSettings(home, profileDir, join(home, 'package.json'))?.settings.minimumAgeHours).toBe(48)
    runMirror(['--profile', 'default', 'off'], { home, profile: 'default', profileDir, installAnchor: join(home, 'package.json'), output: { stdout: () => undefined, stderr: () => undefined } })
    expect(npmMirrorOf(patchLayers(home, loadProfileDirectory('delorun', profileDir, join(home, 'package.json')), []))).toBe(false)
  })

  it('refuses a wrong command line and a profile without the row', () => {
    const request = { home, profile: 'default', profileDir, installAnchor: join(home, 'package.json'), output: { stdout: () => undefined, stderr: () => undefined } }
    expect(() => runMirror(['maybe'], request)).toThrow(new CliError(EXIT.usage, 'usage: delorun plugin mirror [--profile <name>] on|off'))
    expect(() => runMirror(['on'], request)).toThrow(/has no delo-plugin-install-check row/u)
  })
})
