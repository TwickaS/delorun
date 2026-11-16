/**
 * Setup export and import over real profiles: what a setup carries and leaves out, the refusal of a credential, and the
 * import that replaces a profile's setup only through Changes' plugin requests, with the denial cases of a crafted
 * archive: Delorun's own scope, a row that belongs to a computer, a path that climbs, a package.json that names another
 * package, a forged presence and a checksum that differs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { ArchiveImporter, DirectoryWorkspaceStore, encodePublicKey, exportSetupArchive, keyFingerprint, parseSetupDocument, signManifest, type SetupDocument } from '@delorun/archive'
import { listChanges } from '../src/actions.ts'
import { type PluginOperation } from '../src/install-actions.ts'
import { readApproved, type AtComputer } from '../src/records.ts'
import { applySetupImport, collectSetup, planSetupImport } from '../src/setup-transfer/index.ts'
import { fixture, history, migrated, NOW, PROFILE, terminal, type Fixture } from './profile-fixture.ts'
import { rejection } from './support.ts'

vi.setConfig({ testTimeout: 60_000 })

const NOT_RUNNING = async () => undefined

/**
 * @param fx - the fixture.
 * @returns the context the setup functions take.
 */
function context(fx: Fixture) {
  return { home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW }
}

/**
 * @param fx - the fixture.
 * @param patch - the text of the profile's patch layer.
 */
function writePatch(fx: Fixture, patch: string): void {
  writeFileSync(join(fx.profileDir, 'cordis.patch.yml'), patch)
}

/**
 * @param fx - the fixture.
 * @returns the text of the profile's patch layer.
 */
function readPatch(fx: Fixture): string {
  return readFileSync(join(fx.profileDir, 'cordis.patch.yml'), 'utf8')
}

/**
 * Make a registry package look installed, with the lockfile's integrity.
 * @param fx - the fixture.
 * @param name - the package.
 * @param version - its version.
 * @param integrity - the lockfile's integrity.
 */
function install(fx: Fixture, name: string, version: string, integrity: string): void {
  const dir = join(fx.profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  const lock = join(fx.profileDir, 'pnpm-lock.yaml')
  const document = parseDocument(readFileSync(lock, 'utf8'))
  document.setIn(['packages', `${name}@${version}`], document.createNode({ resolution: { integrity } }))
  writeFileSync(lock, document.toString())
}

/**
 * A plugin operation that edits the manifest as pnpm would and records what it was asked.
 * @param fx - the fixture.
 * @param options - `fail` makes it exit 1; `integrity` is what the lockfile records for an added registry package.
 * @returns the operation and its calls.
 */
function operation(fx: Fixture, options: { readonly fail?: boolean, readonly integrity?: string } = {}): PluginOperation & { readonly calls: (readonly string[])[], readonly folders: (string | undefined)[] } {
  const calls: (readonly string[])[] = []
  const folders: (string | undefined)[] = []
  return Object.assign(async (args: readonly string[], folder?: string) => {
    calls.push(args)
    folders.push(folder)
    if (options.fail === true) return { exitCode: 1, failure: 'the registry refused' }
    const path = join(fx.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }
    if (args[0] === 'remove') delete manifest.dependencies[args[1]!]
    else {
      const spec = args[1]!
      const at = spec.lastIndexOf('@')
      manifest.dependencies[spec.slice(0, at)] = spec.slice(at + 1)
      if (!spec.slice(at + 1).startsWith('link:')) install(fx, spec.slice(0, at), spec.slice(at + 1), options.integrity ?? 'sha512-AAAA')
    }
    writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
    return { exitCode: 0 }
  }, { calls, folders })
}

const SOURCE_PATCH = `
- id: llm-deepseek
  config:
    model: deepseek-v4
    apiKeyEnv: DEEPSEEK_API_KEY
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4
- id: sandbox-policy
  config:
    mode: off
- id: llm-pi-ai
  config:
    providers:
      custom:
        baseURL: https://models.example.com/v1
        apiKeyEnv: CUSTOM_KEY
- insert:
    - id: plug-row
      name: plug
      config:
        greeting: hello
- id: delorun-theme
  config:
    palette: !!js ctx.palette
`

/**
 * A source profile with a local plugin, a registry plugin, a product bundle and the patch above.
 * @returns the fixture.
 */
async function source(): Promise<Fixture> {
  const { fx } = await migrated()
  install(fx, 'left-pad', '1.3.0', 'sha512-AAAA')
  const manifestPath = join(fx.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies['@delorun/bundle-local'] = 'workspace:*'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writePatch(fx, SOURCE_PATCH)
  return fx
}

/**
 * A profile that already has a setup of its own to be replaced.
 * @returns the fixture.
 */
function target(): Fixture {
  const fx = fixture()
  const manifestPath = join(fx.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies['old-plugin'] = '^1.0.0'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  install(fx, 'old-plugin', '1.0.0', 'sha512-OLD')
  writePatch(fx, '- id: sandbox-policy\n  config:\n    mode: strict\n    note: !!js ctx.note\n- id: llm-deepseek\n  config:\n    model: old-model\n- id: delorun-cost-meter\n  config:\n    enabled: true\n')
  return fx
}

describe('collectSetup', () => {
  it('carries the person\'s plugins and the model and plugin settings, and names what it leaves out', async () => {
    const fx = await source()
    const collected = await collectSetup(context(fx))
    expect(collected.document.plugins).toEqual([
      { name: 'left-pad', source: 'registry', version: '1.3.0', integrity: 'sha512-AAAA' },
      { name: 'plug', source: 'local', version: '1.0.0', files: expect.arrayContaining([expect.objectContaining({ path: 'package.json' }), expect.objectContaining({ path: 'index.js' })]) },
    ])
    expect(collected.document.patch.map(entry => entry['id'] ?? 'insert')).toEqual(['llm-deepseek', 'agent-default-model', 'llm-pi-ai', 'insert'])
    expect(collected.leftOut.join('\n')).toContain('sandbox-policy')
    expect(collected.leftOut.join('\n')).toContain('holds an expression')
    expect(JSON.stringify(collected)).not.toContain('@delorun/bundle-local')
    for (const file of collected.document.plugins.flatMap(plugin => plugin.source === 'local' ? plugin.files : [])) expect(collected.files.has(file.sha256)).toBe(true)
  })

  it('refuses to export a value for a credential field or text that looks like a key, naming the place and never the value', async () => {
    for (const config of ['providers:\n      openai:\n        apiKey: not-a-real-secret-value', 'note: sk-abcdefghijklmnopqrstuvwxyz']) {
      const fx = await source()
      writePatch(fx, `- id: llm-pi-ai\n  config:\n    ${config}\n`)
      const refused = await rejection(collectSetup(context(fx)), 'SETUP_REFUSED')
      expect(refused.message).toContain('llm-pi-ai')
      expect(refused.message).not.toContain('not-a-real-secret-value')
      expect(refused.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    }
  })

  it('leaves out a local plugin nobody approved yet and an endpoint that is not https', async () => {
    const fx = fixture()
    const manifestPath = join(fx.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['mine'] = 'link:/somewhere/mine'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writePatch(fx, '- id: llm-pi-ai\n  config:\n    providers:\n      x:\n        baseURL: http://models.example.com/v1\n')
    const collected = await collectSetup(context(fx))
    expect(collected.document.plugins).toEqual([])
    expect(collected.document.patch).toEqual([])
    expect(collected.leftOut.join('\n')).toContain('mine: made on this computer and not approved yet')
    expect(collected.leftOut.join('\n')).toContain('not an https URL')
  })
})

/**
 * The document and files a source profile exports.
 * @returns them.
 */
async function exported(): Promise<{ document: SetupDocument, read: (sha256: string) => Uint8Array }> {
  const collected = await collectSetup(context(await source()))
  return { document: collected.document, read: sha256 => collected.files.get(sha256)! }
}

describe('applySetupImport', () => {
  it('replaces the setup through plugin requests: removes, installs, holds local code for review, writes settings, saves a version first', async () => {
    const { document, read } = await exported()
    const fx = target()
    const { plan } = await planSetupImport(context(fx), document)
    expect(plan.remove).toEqual(['old-plugin'])
    expect(plan.install.map(item => [item.plugin.name, item.kind])).toEqual([['left-pad', 'replace'], ['plug', 'add']])
    expect(plan.settings).toContain('back to its default: delorun-cost-meter')
    expect(plan.endpoints.join('\n')).toContain('https://models.example.com/v1')
    expect(plan.keyNotes.join('\n')).toContain('deepseek-official')
    const run = operation(fx)
    const lines: string[] = []
    const applied = await applySetupImport(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run, readFile: read, progress: line => lines.push(line) })
    expect(run.calls.map(call => call.join(' '))).toEqual([
      'remove old-plugin',
      'add left-pad@1.3.0',
      expect.stringMatching(/^add plug@link:.*changes\/profiles\/default\/active\/plug$/u),
    ])
    expect(run.folders[2]).toBe(join(fx.home, 'archive', 'setup-plugins', PROFILE, 'plug'))
    expect(readFileSync(join(fx.home, 'archive', 'setup-plugins', PROFILE, 'plug', 'index.js'), 'utf8')).toContain('export default')
    expect(applied.removed).toEqual(['old-plugin'])
    expect(applied.installed.map(item => item.name)).toEqual(['left-pad', 'plug'])
    expect(applied.installed[1]!.reviewChange).toBeDefined()
    // The code waits for review: nothing approved it.
    expect((await readApproved(fx.profileDir)).plugins['plug']).toBeUndefined()
    expect((await listChanges(context(fx))).pending.map(change => change.plugin)).toContain('plug')
    const patch = readPatch(fx)
    expect(patch).toContain('mode: strict')
    expect(patch).toContain('note: !!js ctx.note')
    expect(patch).not.toContain('old-model')
    expect(patch).not.toContain('delorun-cost-meter')
    expect(patch).toContain('deepseek-v4')
    expect(patch).toContain('plug-row')
    expect(patch).not.toContain('mode: off')
    const subjects = await history(fx)
    expect(subjects[subjects.length - 1]).toBeDefined()
    expect(subjects.join('\n')).toContain('Before importing a setup')
    expect(lines[0]).toContain('Before importing a setup')
  })

  it('plans only the plugin whose code still waits for review when the import is run again', async () => {
    const { document, read } = await exported()
    const fx = target()
    await applySetupImport(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read })
    const again = await planSetupImport(context(fx), document)
    expect(again.plan.remove).toEqual([])
    expect(again.plan.install.map(item => item.plugin.name)).toEqual(['plug'])
  })

  it('refuses a plugin of Delorun\'s own scope before it changes anything', async () => {
    const { document, read } = await exported()
    const evil: SetupDocument = { ...document, plugins: [{ name: '@delorun/bundle-local', source: 'registry', version: '9.9.9' }] }
    const fx = target()
    const run = operation(fx)
    await rejection(applySetupImport(context(fx), evil, { presence: terminal(), reload: NOT_RUNNING, run, readFile: read }), 'SETUP_REFUSED')
    expect(run.calls).toEqual([])
    expect(await history(fx)).toEqual([])
  })

  it('does not apply an entry that belongs to a computer, and refuses one that holds a key', async () => {
    const { document, read } = await exported()
    const fx = target()
    const crafted: SetupDocument = { ...document, plugins: [], patch: [
      { id: 'sandbox-policy', config: { mode: 'off' } },
      { id: 'reach-provider', config: { open: true } },
      { id: 'llm-deepseek', name: 'some-third-party-llm', config: { model: 'm' } },
      { insert: [{ id: 'x', name: 'not-in-the-setup' }] },
    ] }
    const { plan } = await planSetupImport(context(fx), crafted)
    expect(plan.leftOut).toHaveLength(4)
    await applySetupImport(context(fx), crafted, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read })
    expect(readPatch(fx)).toContain('mode: strict')
    expect(readPatch(fx)).not.toContain('reach-provider')
    expect(readPatch(fx)).not.toContain('not-in-the-setup')
    expect(readPatch(fx)).not.toContain('some-third-party-llm')
    const withKey: SetupDocument = { ...document, plugins: [], patch: [{ id: 'llm-deepseek', config: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' } }] }
    const refused = await rejection(planSetupImport(context(fx), withKey), 'SETUP_REFUSED')
    expect(refused.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })

  it('writes nothing outside the plugin\'s folder when a path climbs, and refuses a package.json that names another package', async () => {
    const { document, read } = await exported()
    const fx = target()
    const local = document.plugins.find(plugin => plugin.source === 'local')!
    if (local.source !== 'local') throw new Error('expected a local plugin')
    const climbing: SetupDocument = { ...document, plugins: [{ ...local, files: [...local.files, { path: '../../escape.js', sha256: local.files[0]!.sha256, size: local.files[0]!.size, executable: false }] }] }
    await expect(applySetupImport(context(fx), climbing, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_REJECTED' })
    expect(existsSync(join(fx.home, 'archive', 'setup-plugins', 'escape.js'))).toBe(false)
    expect(existsSync(join(fx.home, 'archive', 'escape.js'))).toBe(false)
    const renamed: SetupDocument = { ...document, plugins: [{ ...local, name: 'other-name' }] }
    await rejection(applySetupImport(context(fx), renamed, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read }), 'SETUP_REFUSED')
  })

  it('needs the person at their computer', async () => {
    const { document, read } = await exported()
    const fx = target()
    const run = operation(fx)
    // A proof the attest functions did not issue, however it looks.
    const forged: AtComputer = Object.create(null)
    await rejection(applySetupImport(context(fx), document, { presence: forged, reload: NOT_RUNNING, run, readFile: read }), 'NOT_AT_COMPUTER')
    expect(run.calls).toEqual([])
  })

  it('stops with the saved version when the plugin operation fails or a package arrives with another checksum', async () => {
    const { document, read } = await exported()
    const failing = target()
    await rejection(applySetupImport(context(failing), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(failing, { fail: true }), readFile: read }), 'OPERATION_FAILED')
    expect((await history(failing)).join('\n')).toContain('Before importing a setup')
    const mismatched = target()
    const refused = await rejection(applySetupImport(context(mismatched), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(mismatched, { integrity: 'sha512-BBBB' }), readFile: read }), 'SETUP_REFUSED')
    expect(refused.message).toContain('another checksum')
    const unchecked = target()
    const noLock = operation(unchecked)
    const bare: SetupDocument = { ...document, plugins: [{ name: 'left-pad', source: 'registry', version: '1.3.0', integrity: 'sha512-CCCC' }], patch: [] }
    const run = Object.assign(async (args: readonly string[], folder?: string) => {
      const result = await noLock(args, folder)
      writeFileSync(join(unchecked.profileDir, 'pnpm-lock.yaml'), '')
      return result
    }, noLock)
    expect((await rejection(applySetupImport(context(unchecked), bare, { presence: terminal(), reload: NOT_RUNNING, run, readFile: read }), 'SETUP_REFUSED')).message).toContain('could not be checked')
  })
})

describe('through an archive', () => {
  it('imports from the opened archive: the files are the ones the signed document names', async () => {
    const collected = await collectSetup(context(await source()))
    const { homeKeyId, publicKey, privateKey } = await ownKey()
    const bytes = exportSetupArchive({
      createdBy: 'test', origin: { homeKeyId, publicKey }, document: collected.document, files: collected.files,
      sign: manifest => signManifest(manifest, homeKeyId, privateKey),
    })
    const opened = new ArchiveImporter({ stagingParent: join(tmpdir(), 'unused-staging'), store: new DirectoryWorkspaceStore(join(tmpdir(), 'unused-store')), trustedPublicKeys: [publicKey] }).openSetup(bytes)
    expect(opened.state).toBe('verified')
    const fx = target()
    await applySetupImport(context(fx), opened.document, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: opened.readFile })
    expect(readFileSync(join(fx.home, 'archive', 'setup-plugins', PROFILE, 'plug', 'package.json'), 'utf8')).toContain('"name":"plug"')
    expect(parseSetupDocument(new TextEncoder().encode(JSON.stringify(opened.document)))).toEqual(collected.document)
  })
})

/**
 * @returns a fresh Ed25519 key in the forms an archive's origin and signature take.
 */
async function ownKey(): Promise<{ homeKeyId: string, publicKey: string, privateKey: KeyObject }> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const encoded = encodePublicKey(publicKey)
  return { homeKeyId: keyFingerprint(encoded), publicKey: encoded, privateKey }
}
