/**
 * The reader of the bundles a target release loads (`delorun/apps/cli/src/update/bundle-layers.ts`), over a temporary
 * target runtime and profile written file by file: where a bundle resolves from, each of upstream's skip rules, the
 * rows of the patch layers that load, and every form of metadata Delorun cannot read, which is an unverified skip.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { bundleRowItems } from '@delorun/update'
import { BundleReadError, bundleAnchors, readBundleLayers, signedBundleAnchors, type BundleLayerOptions } from '../../src/update/bundle-layers.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'dbl-')))
const runtime = join(base, 'runtime')
const profileDir = join(base, 'profile')
const v = (text: string): SemanticVersion => brandString<SemanticVersion>(text)

/** The target the specs check against: DSH 0.3.0 and Delorun 1.1.0 on Linux, with no exemption. */
const OPTIONS: BundleLayerOptions = { anchors: bundleAnchors(runtime, profileDir), versions: { dsh: v('0.3.0'), delorun: v('1.1.0') }, exemptions: {}, platform: 'linux' }

/** A patch inserting one row. */
const ONE_ROW = '- insert:\n    - id: row\n      name: plugin-row\n'

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(runtime, { recursive: true, force: true })
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"profile","private":true}\n')
})

/**
 * Write a bundle package.
 * @param where - the target runtime's `app/node_modules` or the profile's `node_modules`.
 * @param name - the package name.
 * @param manifest - its `package.json`: an object is written as JSON, a string as it is.
 * @param files - its other files by relative path.
 */
function writeBundle(where: 'target' | 'profile', name: string, manifest: Record<string, unknown> | string, files: Readonly<Record<string, string>> = { 'cordis.patch.yml': ONE_ROW }): void {
  const directory = where === 'target' ? join(runtime, 'app', 'node_modules', name) : join(profileDir, 'node_modules', name)
  for (const [path, content] of Object.entries({ 'package.json': typeof manifest === 'string' ? manifest : JSON.stringify(manifest), ...files })) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), content)
  }
}

/**
 * A bundle manifest.
 * @param name - the package name.
 * @param change - fields to add or replace.
 * @returns the manifest, declaring `./cordis.patch.yml`.
 */
function bundle(name: string, change: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...change }
}

/**
 * Read one bundle and return its only skip.
 * @param name - the bundle.
 * @param options - the target; {@link OPTIONS} by default.
 * @returns the skipped bundle.
 */
async function skipOf(name: string, options: BundleLayerOptions = OPTIONS): Promise<unknown> {
  const read = await readBundleLayers([name], options)
  expect(read.layers).toEqual([])
  expect(read.skipped).toHaveLength(1)
  return read.skipped[0]
}

describe('bundleAnchors', () => {
  it('names the target\'s install anchor first and the profile\'s manifest second', () => {
    expect(bundleAnchors('/r', '/p')).toEqual(['/r/app/node_modules/@deepseek-ai/dsh/package.json', '/p/package.json'])
  })
})

describe('readBundleLayers', () => {
  describe('the layers that load', () => {
    it('reads each row a bundle\'s patch inserts, a group\'s children included, and leaves out the rows the patch disables', async () => {
      writeBundle('target', '@a/bundle', bundle('@a/bundle'), {
        'cordis.patch.yml': [
          '- insert:',
          '    - id: first',
          '      name: plugin-first',
          '    - name: plugin-nameless',
          '    - id: off',
          '      name: plugin-off',
          '      disabled: true',
          '    - id: maybe',
          '      name: plugin-maybe',
          '      disabled: !!js "!ctx.get(\'profileContext\')"',
          '    - id: tools',
          '      group: true',
          '      config:',
          '        - id: inner',
          '          name: plugin-inner',
          '    - id: quiet',
          '      group: true',
          '      disabled: true',
          '      config:',
          '        - name: plugin-quiet',
          '- id: first',
          '  config: { level: 2 }',
          '',
        ].join('\n'),
      })

      expect(await readBundleLayers(['@a/bundle'], OPTIONS)).toEqual({
        layers: [{ layer: '@a/bundle', disabledRows: ['off'], rows: [
          { id: 'first', name: 'plugin-first', plugins: ['plugin-first'] },
          { name: 'plugin-nameless', plugins: ['plugin-nameless'] },
          { id: 'maybe', name: 'plugin-maybe', plugins: ['plugin-maybe'] },
          { id: 'inner', name: 'plugin-inner', plugins: ['plugin-inner'] },
        ], settings: [
          { id: 'first', plugin: 'plugin-first', config: {} },
          { id: 'maybe', plugin: 'plugin-maybe', config: {} },
          { id: 'inner', plugin: 'plugin-inner', config: {} },
          { id: 'first', config: { level: 2 } },
        ] }],
        skipped: [],
      })
    })

    it('reads the rows a patch disables, by entry or as a disabled inserted row, and not an expression', async () => {
      writeBundle('target', 'off', bundle('off', { dsh: { bundle: { patch: './cordis.patch.yml' } } }), {
        'cordis.patch.yml': [
          '- id: llm-deepseek-account',
          '  disabled: true',
          '- id: by-expression',
          '  disabled: !!js false',
          '- id: no-disable',
          '  config: {}',
          '- insert:',
          '    - id: inserted-off',
          '      name: plugin-off',
          '      disabled: true',
          '',
        ].join('\n'),
      })

      expect((await readBundleLayers(['off'], OPTIONS)).layers).toEqual([{ layer: 'off', rows: [], disabledRows: ['llm-deepseek-account', 'inserted-off'], settings: [{ id: 'no-disable', config: {} }] }])
    })

    it('lets the report name nothing for a row the running and the target release both disable through their patches', async () => {
      const patch = '- id: llm-deepseek-account\n  disabled: true\n'
      writeBundle('target', 'shared', bundle('shared'), { 'cordis.patch.yml': patch })
      writeBundle('profile', 'shared', bundle('shared'), { 'cordis.patch.yml': patch })
      const target = (await readBundleLayers(['shared'], OPTIONS)).layers
      const running = (await readBundleLayers(['shared'], { ...OPTIONS, anchors: bundleAnchors(join(base, 'no-runtime'), profileDir) })).layers

      expect(target[0]?.disabledRows).toEqual(['llm-deepseek-account'])
      expect(running[0]?.disabledRows).toEqual(['llm-deepseek-account'])
      expect(bundleRowItems(target, running, v('1.1.0'))).toEqual([])
    })

    it('reads every patch file a list declares, in order', async () => {
      writeBundle('target', 'two-files', bundle('two-files', { dsh: { bundle: { patch: ['./a.yml', './b.yml'] } } }), {
        'a.yml': '- insert:\n    - name: plugin-a\n',
        'b.yml': '- insert:\n    - name: plugin-b\n',
      })

      expect((await readBundleLayers(['two-files'], OPTIONS)).layers).toEqual([{ layer: 'two-files', disabledRows: [], rows: [{ name: 'plugin-a', plugins: ['plugin-a'] }, { name: 'plugin-b', plugins: ['plugin-b'] }], settings: [] }])
    })

    it('resolves a bundle from the target before the profile, and from the profile when the target does not carry it', async () => {
      writeBundle('target', 'shared', bundle('shared'), { 'cordis.patch.yml': '- insert:\n    - name: from-target\n' })
      writeBundle('profile', 'shared', bundle('shared'), { 'cordis.patch.yml': '- insert:\n    - name: from-profile\n' })
      writeBundle('profile', 'own', bundle('own'), { 'cordis.patch.yml': '- insert:\n    - name: own-row\n' })

      expect((await readBundleLayers(['shared', 'own'], OPTIONS)).layers).toEqual([
        { layer: 'shared', disabledRows: [], rows: [{ name: 'from-target', plugins: ['from-target'] }], settings: [] },
        { layer: 'own', disabledRows: [], rows: [{ name: 'own-row', plugins: ['own-row'] }], settings: [] },
      ])
    })

    it('loads a bundle whose platforms list this machine\'s, and one whose requirements the target meets', async () => {
      writeBundle('target', 'fits', bundle('fits', { dsh: { bundle: { patch: './cordis.patch.yml', platforms: ['darwin', 'linux'] } }, engines: { dsh: '^0.3.0', delorun: '>=1.0.0' } }))
      writeBundle('target', 'peers', bundle('peers', { peerDependencies: { '@deepseek-ai/cordis': '^9.0.0', '@deepseek-ai/dsh': '0.3.0', '@deepseek-ai/dsh-shell-env': 'workspace:*' } }))

      expect((await readBundleLayers(['fits', 'peers'], OPTIONS)).layers.map(layer => layer.layer)).toEqual(['fits', 'peers'])
    })

    it('takes engines.dsh alone and leaves the peers unread when it is declared', async () => {
      writeBundle('target', 'engines-first', bundle('engines-first', { engines: { dsh: '>=0.3.0' }, peerDependencies: { '@deepseek-ai/dsh-x': 7 } }))

      expect((await readBundleLayers(['engines-first'], OPTIONS)).skipped).toEqual([])
    })

    it('loads a bundle whose unmet DSH requirement the profile exempts for this exact version', async () => {
      writeBundle('target', 'exempt', bundle('exempt', { engines: { dsh: '^0.2.0' } }))

      expect((await readBundleLayers(['exempt'], { ...OPTIONS, exemptions: { 'exempt@1.0.0': [v('0.3.0')] } })).skipped).toEqual([])
    })
  })

  describe('the bundles the target skips', () => {
    it('skips a bundle neither the target nor the profile installs, a Node built-in name included', async () => {
      expect(await readBundleLayers(['@a/absent', 'fs'], OPTIONS)).toEqual({ layers: [], skipped: [
        { package: '@a/absent', reason: 'neither the target release nor the profile installs it', verification: 'verified' },
        { package: 'fs', reason: 'neither the target release nor the profile installs it', verification: 'verified' },
      ] })
    })

    it('skips a package that declares no dsh.bundle', async () => {
      writeBundle('target', 'plain', { name: 'plain', version: '1.0.0' })
      writeBundle('target', 'odd-dsh', { name: 'odd-dsh', version: '1.0.0', dsh: 'bundle' })

      expect((await readBundleLayers(['plain', 'odd-dsh'], OPTIONS)).skipped).toEqual([
        { package: 'plain', reason: 'its package.json declares no dsh.bundle', verification: 'verified' },
        { package: 'odd-dsh', reason: 'its package.json declares no dsh.bundle', verification: 'verified' },
      ])
    })

    it('skips a bundle whose platforms leave this machine\'s out', async () => {
      writeBundle('target', 'mac-only', bundle('mac-only', { dsh: { bundle: { patch: './cordis.patch.yml', platforms: ['darwin', 'win32'] } } }))

      expect(await skipOf('mac-only')).toEqual({ package: 'mac-only', reason: 'it supports the platforms darwin, win32, not linux', verification: 'verified' })
    })

    it('skips a bundle whose engines.dsh the target does not meet, and one the exemption names for another version', async () => {
      writeBundle('target', 'old', bundle('old', { engines: { dsh: '^0.2.0' } }))

      expect(await skipOf('old')).toEqual({ package: 'old', reason: 'it requires DSH ^0.2.0 and the target runs DSH 0.3.0', verification: 'verified' })
      expect(await skipOf('old', { ...OPTIONS, exemptions: { 'old@1.0.0': [v('0.2.2')], 'old@0.9.0': [v('0.3.0')] } })).toMatchObject({ verification: 'verified' })
    })

    it('skips a bundle whose DSH peer the target does not meet', async () => {
      writeBundle('target', 'peer-old', bundle('peer-old', { peerDependencies: { '@deepseek-ai/dsh-shell-env': '0.2.2', '@deepseek-ai/dsh': '>=0.3.0' } }))

      expect(await skipOf('peer-old')).toEqual({ package: 'peer-old', reason: 'it requires @deepseek-ai/dsh-shell-env 0.2.2 and the target runs DSH 0.3.0', verification: 'verified' })
    })

    it('skips a bundle whose engines.delorun the target does not meet, whatever the DSH exemption says', async () => {
      writeBundle('target', 'delorun-new', bundle('delorun-new', { engines: { delorun: '>=2.0.0' } }))
      writeBundle('target', 'both', bundle('both', { engines: { dsh: '^0.2.0', delorun: '>=2.0.0' } }))
      const exemptions = { 'both@1.0.0': [v('0.3.0')] }

      expect(await skipOf('delorun-new')).toEqual({ package: 'delorun-new', reason: 'it requires Delorun >=2.0.0 and the target installs Delorun 1.1.0', verification: 'verified' })
      expect(await skipOf('both', { ...OPTIONS, exemptions })).toEqual({ package: 'both', reason: 'it requires Delorun >=2.0.0 and the target installs Delorun 1.1.0', verification: 'verified' })
    })

    it('loads a bundle whose engines.delorun the target meets although its engines.dsh and DSH peers do not (A567)', async () => {
      writeBundle('target', 'delorun-led', bundle('delorun-led', { engines: { dsh: '^0.2.0', delorun: '^1.0.0' }, peerDependencies: { '@deepseek-ai/dsh-shell-env': '0.2.2' } }))
      writeBundle('target', 'delorun-bad-dsh', bundle('delorun-bad-dsh', { engines: { dsh: 3, delorun: '^1.0.0' } }))

      const read = await readBundleLayers(['delorun-led', 'delorun-bad-dsh'], OPTIONS)
      expect(read.skipped).toEqual([])
      expect(read.layers.map(layer => layer.layer)).toEqual(['delorun-led', 'delorun-bad-dsh'])
    })

    it('keeps reading the list after a bundle it skips', async () => {
      writeBundle('target', 'good', bundle('good'))

      const read = await readBundleLayers(['@a/absent', 'good'], OPTIONS)

      expect(read.skipped.map(entry => entry.package)).toEqual(['@a/absent'])
      expect(read.layers.map(layer => layer.layer)).toEqual(['good'])
    })
  })

  describe('metadata Delorun cannot read', () => {
    /**
     * Write a bundle and read its skip, which must be unverified.
     * @param name - the bundle.
     * @param manifest - its `package.json`.
     * @param files - its other files.
     * @returns the skip's reason.
     */
    async function unverified(name: string, manifest: Record<string, unknown> | string, files?: Readonly<Record<string, string>>): Promise<string> {
      writeBundle('target', name, manifest, files)
      const skipped = await skipOf(name)
      expect(skipped).toMatchObject({ package: name, verification: 'unverified' })
      return (skipped as { readonly reason: string }).reason
    }

    it('names a package.json that is not JSON, or not an object', async () => {
      expect(await unverified('not-json', '{"name": ')).toMatch(/^Delorun could not read its package\.json: SyntaxError: /u)
      expect(await unverified('array', '[]')).toBe('its package.json is not a JSON object')
    })

    it('names a dsh.bundle whose patch or platforms upstream refuses', async () => {
      const sentence = 'its dsh.bundle needs patch as a file path or a list of file paths, and platforms, when given, as a nonempty list of Node platform names'
      expect(await unverified('no-patch', bundle('no-patch', { dsh: { bundle: {} } }))).toBe(sentence)
      expect(await unverified('number-patch', bundle('number-patch', { dsh: { bundle: { patch: 3 } } }))).toBe(sentence)
      expect(await unverified('null-bundle', bundle('null-bundle', { dsh: { bundle: null } }))).toBe(sentence)
      expect(await unverified('no-platforms', bundle('no-platforms', { dsh: { bundle: { patch: './cordis.patch.yml', platforms: [] } } }))).toBe(sentence)
      expect(await unverified('odd-platform', bundle('odd-platform', { dsh: { bundle: { patch: './cordis.patch.yml', platforms: ['plan9'] } } }))).toBe(sentence)
    })

    it('names engines, a peer range or a mismatched bundle\'s identity in a form upstream refuses', async () => {
      expect(await unverified('null-engines', bundle('null-engines', { engines: null }))).toBe('its package.json declares engines in a form Delorun cannot read')
      expect(await unverified('number-dsh', bundle('number-dsh', { engines: { dsh: 3 } }))).toBe('its package.json declares engines in a form Delorun cannot read')
      expect(await unverified('number-delorun', bundle('number-delorun', { engines: { delorun: false } }))).toBe('its package.json declares engines in a form Delorun cannot read')
      expect(await unverified('number-peer', bundle('number-peer', { peerDependencies: { 'left-pad': 1 } }))).toBe('its package.json declares peerDependencies in a form Delorun cannot read')
      expect(await unverified('nameless', { version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, engines: { dsh: '^0.2.0' } })).toBe('its package.json declares its name or version in a form Delorun cannot read')
      expect(await unverified('blank-version', bundle('blank-version', { version: ' ', engines: { dsh: '^0.2.0' } }))).toBe('its package.json declares its name or version in a form Delorun cannot read')
    })

    it('names a patch file that is missing, not YAML or not a list of patch entries', async () => {
      expect(await unverified('missing-patch', bundle('missing-patch'), {})).toMatch(/^Delorun could not read its patch \.\/cordis\.patch\.yml: Error: ENOENT/u)
      expect(await unverified('bad-yaml', bundle('bad-yaml'), { 'cordis.patch.yml': '- insert: [\n' })).toMatch(/^Delorun could not read its patch \.\/cordis\.patch\.yml: YAMLParseError: [^\n]+$/u)
      expect(await unverified('empty-patch', bundle('empty-patch'), { 'cordis.patch.yml': '' })).toBe('its patch ./cordis.patch.yml is not a list of patch entries')
      expect(await unverified('scalar-entry', bundle('scalar-entry'), { 'cordis.patch.yml': '- just text\n' })).toBe('its patch ./cordis.patch.yml holds an entry that is not a mapping')
      expect(await unverified('map-insert', bundle('map-insert'), { 'cordis.patch.yml': '- insert:\n    name: plugin\n' })).toBe('its patch ./cordis.patch.yml holds an insert that is not a list')
      expect(await unverified('scalar-row', bundle('scalar-row'), { 'cordis.patch.yml': '- insert:\n    - plugin\n' })).toBe('its patch ./cordis.patch.yml inserts a row that is not a mapping')
      expect(await unverified('nameless-row', bundle('nameless-row'), { 'cordis.patch.yml': '- insert:\n    - id: row\n' })).toBe('its patch ./cordis.patch.yml inserts a row that names no plugin')
    })

    it('raises a typed error that names its code and the bundle', () => {
      const error = new BundleReadError('BUNDLE_PATCH_UNREADABLE', '@a/bundle', 'its patch is gone')

      expect(error).toMatchObject({ name: 'BundleReadError', code: 'BUNDLE_PATCH_UNREADABLE', bundle: '@a/bundle', detail: 'its patch is gone', message: 'BUNDLE_PATCH_UNREADABLE: @a/bundle: its patch is gone' })
    })
  })

  it('lets any other failure reach the caller', async () => {
    await expect(readBundleLayers(['@a/bundle'], { ...OPTIONS, anchors: ['relative/anchor'] })).rejects.toThrow(TypeError)
  })
})

describe('the settings a patch gives rows', () => {
  const patch = [
    '- id: plugin-manager',
    '  config:',
    '    protectedPlugins: [plugin-seats]',
    '    fallbackRegistries: !!js "process.env.MIRROR ? [1] : []"',
    '- insert:',
    '    - id: seats',
    '      name: plugin-seats',
    '      config:',
    '        enabled: true',
    '        seats: [{ provider: a, limit: 2 }]',
    '    - id: bare',
    '      name: plugin-bare',
    '    - id: off',
    '      name: plugin-off',
    '      disabled: true',
    '      config: { enabled: true }',
    '    - id: tools',
    '      group: true',
    '      config:',
    '        - id: inner',
    '          name: plugin-inner',
    '          config: { depth: 1 }',
    '    - name: plugin-without-id',
    '      config: { enabled: true }',
    '    - id: whole',
    '      name: plugin-whole',
    '      config: !!js "{ enabled: true }"',
    '',
  ].join('\n')

  it('reads each row\'s top-level config keys as JSON values, an update entry\'s without a plugin, and a bare row as an empty config', async () => {
    writeBundle('target', '@a/bundle', bundle('@a/bundle'), { 'cordis.patch.yml': patch })

    const { settings } = (await readBundleLayers(['@a/bundle'], OPTIONS)).layers[0] ?? {}

    expect(settings).toEqual([
      { id: 'plugin-manager', config: { protectedPlugins: ['plugin-seats'], fallbackRegistries: 'process.env.MIRROR ? [1] : []' } },
      { id: 'seats', plugin: 'plugin-seats', config: { enabled: true, seats: [{ provider: 'a', limit: 2 }] } },
      { id: 'bare', plugin: 'plugin-bare', config: {} },
      { id: 'inner', plugin: 'plugin-inner', config: { depth: 1 } },
      { id: 'whole', plugin: 'plugin-whole', config: {} },
    ])
  })

  it('reads through the caller\'s reader, and a file it refuses makes the bundle an unverified skip', async () => {
    writeBundle('target', 'signed', bundle('signed'))
    const reads: string[] = []
    const refusing = async (path: string): Promise<string> => {
      reads.push(path)
      if (path.endsWith('cordis.patch.yml')) throw new Error('differs from its signed digest')
      return (await import('node:fs/promises')).readFile(path, 'utf8')
    }

    expect(await skipOf('signed', { ...OPTIONS, readText: refusing })).toEqual({ package: 'signed', reason: 'Delorun could not read its patch ./cordis.patch.yml: Error: differs from its signed digest', verification: 'unverified' })
    expect(reads.map(path => path.slice(path.lastIndexOf('/') + 1))).toEqual(['package.json', 'cordis.patch.yml'])
  })

  it('resolves a bundle only from the release\'s own files when the caller asks for it', async () => {
    writeBundle('profile', 'planted', bundle('planted'))
    writeBundle('target', 'signed', bundle('signed'))
    const signed = { ...OPTIONS, anchors: signedBundleAnchors(runtime), within: join(runtime, 'app') }

    expect(signedBundleAnchors('/r')).toEqual(['/r/app/node_modules/@deepseek-ai/dsh/package.json'])
    expect((await readBundleLayers(['signed'], signed)).layers.map(layer => layer.layer)).toEqual(['signed'])
    expect(await skipOf('planted', { ...OPTIONS, within: join(runtime, 'app') })).toMatchObject({ reason: 'neither the target release nor the profile installs it', verification: 'verified' })
    expect(await skipOf('planted', signed)).toMatchObject({ reason: 'neither the target release nor the profile installs it' })
  })
})
