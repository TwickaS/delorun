import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildData, dataText, DATA_PATH, gitSources } from '../src/plugin-browser/generate.ts'
import { needPhrase, patchRows, readPluginList } from '../src/plugin-browser/list-plugins.ts'
import { readFileSync } from 'node:fs'

const ROOT = join(import.meta.dirname, '../../../..')

function tree(files: Record<string, string>, test: { onTestFinished: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'delorun-plugin-list-'))
  test.onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  return root
}

const pkg = (name: string, delorun: object, extra: object = {}): string => JSON.stringify({ name, delorun, ...extra })
const words = (title: string): string => JSON.stringify({ meta: { title, description: `${title} sentence.` } })
const rows = (...entries: string[]): string => `- insert:\n${entries.join('')}`
const row = (id: string, name: string, disabled = false): string => `    - id: ${id}\n      name: '${name}'\n${disabled ? '      disabled: true\n' : ''}`

const COUNT = { countFiles: (folder: string) => folder.length }

describe('the plugin list', () => {
  it('lists patch rows by standing, then packs, and leaves out libraries', (test) => {
    const root = tree({
      'delorun/packages/bundle-local/cordis.patch.yml': rows(row('a', '@delorun/plugin-a'), row('sub', '@delorun/bundle-local/trust')),
      'delorun/packages/bundle-studio/cordis.patch.yml': rows(row('b', '@delorun/plugin-b', true), row('c', '@delorun/plugin-c')),
      'delorun/packages/bundle-headless/cordis.patch.yml': rows(row('h', '@delorun/plugin-h'), row('a2', '@delorun/plugin-a')),
      'delorun/packages/bundle-local/package.json': pkg('@delorun/bundle-local', { state: 'shipped' }),
      'delorun/packages/bundle-local/locale/en.json': words('Local'),
      'delorun/packages/plugin-a/package.json': pkg('@delorun/plugin-a', { state: 'shipped' }),
      'delorun/packages/plugin-a/locale/en.json': words('A'),
      'delorun/packages/plugin-b/package.json': pkg('@delorun/plugin-b', { state: 'experimental' }),
      'delorun/packages/plugin-b/locale/en.json': words('B'),
      'delorun/packages/plugin-c/package.json': pkg('@delorun/plugin-c', { state: 'shipped' }),
      'delorun/packages/plugin-h/package.json': pkg('@delorun/plugin-h', { state: 'shipped' }),
      'delorun/packages/bundle-pack/package.json': pkg('@delorun/bundle-pack', { state: 'experimental', pack: true, requires: { r1: { needs: [{ kind: 'program', names: ['codex'] }, { kind: 'program', names: ['claude'] }, { kind: 'env', name: 'SECRET' }] }, r2: { needs: [{ kind: 'env', name: 'SECRET' }, { kind: 'platform', os: ['linux', 'darwin'] }] }, r3: { needs: [{ kind: 'program', names: ['codex', 'claude'] }] } } }),
      'delorun/packages/library/package.json': pkg('@delorun/library', { state: 'shipped' }),
    }, test)
    const { plugins, unworded } = readPluginList(root, COUNT)
    expect(plugins.map((plugin) => `${plugin.standing} ${plugin.name}`)).toEqual([
      'on @delorun/plugin-a',
      'on @delorun/bundle-local',
      'on @delorun/plugin-c',
      'off @delorun/plugin-b',
      'headless @delorun/plugin-h',
      'pack @delorun/bundle-pack',
    ])
    expect(plugins[1]).toMatchObject({ title: 'Local', sentence: 'Local sentence.', state: 'shipped', files: 'delorun/packages/bundle-local'.length, folder: 'delorun/packages/bundle-local' })
    expect(plugins.at(-1)?.requires).toEqual(['the SECRET setting', 'codex or claude installed'])
    expect(unworded).toEqual(['@delorun/plugin-c', '@delorun/plugin-h', '@delorun/bundle-pack'])
  })

  it('refuses a row whose package does not exist and a disabled that is not literal', (test) => {
    const missing = tree({
      'delorun/packages/bundle-local/cordis.patch.yml': rows(row('a', '@delorun/nowhere')),
      'delorun/packages/bundle-studio/cordis.patch.yml': '[]\n',
      'delorun/packages/bundle-headless/cordis.patch.yml': '[]\n',
    }, test)
    expect(() => readPluginList(missing, COUNT)).toThrow(/names @delorun\/nowhere/)
    expect(() => patchRows("- insert:\n    - id: x\n      name: '@delorun/y'\n      disabled: !!js 'a'\n", 'p.yml')).toThrow(/not a literal/)
  })

  it('words each kind of need and refuses an unknown one', () => {
    expect(needPhrase({ kind: 'platform', os: ['linux', 'darwin'] })).toBe('Linux or macOS as the operating system')
    expect(needPhrase({ kind: 'playwright-browser', browser: 'chromium' })).toBe('a one-off chromium download')
    expect(needPhrase({ kind: 'browse-paired' })).toBe('your own browser paired with it')
    expect(() => needPhrase({ kind: 'surprise' })).toThrow(/unknown kind/)
  })
})

describe('the generated data file', () => {
  it('equals what the bundles\' entries, the packs and the scaffold give now', () => {
    expect(readFileSync(DATA_PATH, 'utf8')).toBe(dataText(buildData(ROOT, gitSources)))
  })

  it('lists the seven packs and no library', () => {
    const { plugins, scaffold } = buildData(ROOT, gitSources)
    expect(plugins.filter((plugin) => plugin.standing === 'pack')).toHaveLength(7)
    expect(plugins.map((plugin) => plugin.name)).not.toContain('@delorun/plugin-scaffold')
    expect(Object.keys(scaffold)).toEqual(['tool', 'preset', 'ui', 'bundle'])
  })
})
