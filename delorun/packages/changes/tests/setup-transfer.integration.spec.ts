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
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { listChanges } from '../src/actions.ts'
import { type PluginOperation } from '../src/install-actions.ts'
import { readApproved, type AtComputer } from '../src/records.ts'
import { applySetupImport, collectSetup, discardImportReviews, exportablePlugins, planSetupImport, type CollectOptions } from '../src/setup-transfer/index.ts'
import { fixture, history, migrated, NOW, PROFILE, terminal, type Fixture } from './profile-fixture.ts'
import { rejection } from './support.ts'

vi.setConfig({ testTimeout: 60_000 })

const NOT_RUNNING = async () => undefined

/**
 * Apply a setup with the endpoint confirmation given, unless the case says otherwise.
 * @param ctx - the profile.
 * @param document - the setup.
 * @param options - the apply options.
 * @returns what applySetupImport returns.
 */
function confirmedApply(ctx: Parameters<typeof applySetupImport>[0], document: SetupDocument, options: Parameters<typeof applySetupImport>[2]) {
  return applySetupImport(ctx, document, { ...options, choices: { settings: true, removeOthers: false, ...options.choices, endpointsConfirmed: options.choices?.endpointsConfirmed ?? true } })
}

/** Settings replaced and every plugin the file does not list removed. */
const REPLACE_ALL = { settings: true, removeOthers: true }

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
    expect(collected.document.models.map(entry => entry['id'])).toEqual(['llm-deepseek', 'agent-default-model', 'llm-pi-ai'])
    expect(collected.document.settings.map(entry => entry['id'] ?? 'insert')).toEqual(['insert'])
    expect(collected.document.includesSettings).toBe(true)
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
    expect([...collected.document.models, ...collected.document.settings]).toEqual([])
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
    const { plan } = await planSetupImport(context(fx), document, REPLACE_ALL)
    expect(plan.remove).toEqual(['old-plugin'])
    expect(plan.install.map(item => [item.plugin.name, item.kind])).toEqual([['left-pad', 'replace'], ['plug', 'add']])
    expect(plan.settings).toContain('back to its default: delorun-cost-meter')
    expect(plan.endpoints.join('\n')).toContain('https://models.example.com/v1')
    expect(plan.keyNotes.join('\n')).toContain('deepseek-official')
    const run = operation(fx)
    const lines: string[] = []
    const applied = await confirmedApply(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run, readFile: read, choices: REPLACE_ALL, progress: line => lines.push(line) })
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

  it('leaves no half-written folder when a file of a local plugin cannot be written', async () => {
    const { document, read } = await exported()
    const fx = target()
    const failing = (sha256: string): Uint8Array => {
      const bytes = read(sha256)
      if (Buffer.from(bytes).toString('utf8').startsWith('export default')) throw new Error('the disk is full')
      return bytes
    }
    await expect(confirmedApply(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: failing, choices: REPLACE_ALL })).rejects.toThrow('could not hold the entry "index.js"')
    expect(existsSync(join(fx.home, 'archive', 'setup-plugins', PROFILE, 'plug'))).toBe(false)
  })

  it('plans only the plugin whose code still waits for review when the import is run again', async () => {
    const { document, read } = await exported()
    const fx = target()
    await confirmedApply(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read })
    const again = await planSetupImport(context(fx), document)
    expect(again.plan.remove).toEqual([])
    expect(again.plan.install.map(item => item.plugin.name)).toEqual(['plug'])
  })

  it('refuses a plugin of Delorun\'s own scope before it changes anything', async () => {
    const { document, read } = await exported()
    const evil: SetupDocument = { ...document, plugins: [{ name: '@delorun/bundle-local', source: 'registry', version: '9.9.9' }] }
    const fx = target()
    const run = operation(fx)
    await rejection(confirmedApply(context(fx), evil, { presence: terminal(), reload: NOT_RUNNING, run, readFile: read }), 'SETUP_REFUSED')
    expect(run.calls).toEqual([])
    expect(await history(fx)).toEqual([])
  })

  it('does not apply an entry that belongs to a computer, and refuses one that holds a key', async () => {
    const { document, read } = await exported()
    const fx = target()
    const crafted: SetupDocument = { ...document, plugins: [], models: [], settings: [
      { id: 'sandbox-policy', config: { mode: 'off' } },
      { id: 'reach-provider', config: { open: true } },
      { id: 'llm-deepseek', name: 'some-third-party-llm', config: { model: 'm' } },
      { insert: [{ id: 'x', name: 'not-in-the-setup' }] },
    ] }
    const { plan } = await planSetupImport(context(fx), crafted)
    expect(plan.leftOut).toHaveLength(4)
    await confirmedApply(context(fx), crafted, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read })
    expect(readPatch(fx)).toContain('mode: strict')
    expect(readPatch(fx)).not.toContain('reach-provider')
    expect(readPatch(fx)).not.toContain('not-in-the-setup')
    expect(readPatch(fx)).not.toContain('some-third-party-llm')
    const withKey: SetupDocument = { ...document, plugins: [], settings: [], models: [{ id: 'llm-deepseek', config: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' } }] }
    const refused = await rejection(planSetupImport(context(fx), withKey), 'SETUP_REFUSED')
    expect(refused.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })

  it('never carries the rows of a protection, with or without a plugin\'s name on them, and leaves the profile\'s own alone', async () => {
    const { document, read } = await exported()
    const fx = target()
    writePatch(fx, `${readPatch(fx)}- id: delorun-plugin-install-check\n  config:\n    enabled: true\n- id: session-log-deepseek\n  config:\n    enabled: false\n`)
    const rows = ['delorun-plugin-install-check', 'delorun-privacy', 'session-log-deepseek', 'delorun-permission-defaults', 'delorun-changes', 'sandbox-policy', 'connection', 'tool-bash']
    const crafted: SetupDocument = {
      ...document, plugins: [{ name: 'plug', source: 'registry', version: '1.0.0' }], models: [],
      settings: [
        ...rows.map(id => ({ id, config: { enabled: false } })),
        ...rows.map(id => ({ id, name: 'plug', config: { enabled: false } })),
        ...rows.map(id => ({ insert: [{ id, name: 'plug', config: { enabled: false } }] })),
        { insert: [{ id: 'plug-delorun-extra', name: 'plug', config: { enabled: false } }] },
        { insert: [{ name: 'plug', disabled: true }] },
      ],
    }
    const { plan } = await planSetupImport(context(fx), crafted)
    expect(plan.leftOut.filter(line => line.includes('install-check'))).toHaveLength(3)
    // Only the plugin's own inserted rows are carried.
    await confirmedApply(context(fx), crafted, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read })
    const patch = readPatch(fx)
    expect(patch).toContain('id: delorun-plugin-install-check\n  config:\n    enabled: true')
    expect(patch).toContain('id: session-log-deepseek\n  config:\n    enabled: false')
    expect(patch).toContain('plug-delorun-extra')
    // The profile's own session-log row and the plugin's own inserted row; no protection row took the imported value.
    expect((patch.match(/enabled: false/gu) ?? []).length).toBe(2)
    expect(patch).not.toContain('delorun-privacy')
  })

  it('writes nothing outside the plugin\'s folder when a path climbs, and refuses a package.json that names another package', async () => {
    const { document, read } = await exported()
    const fx = target()
    const local = document.plugins.find(plugin => plugin.source === 'local')!
    if (local.source !== 'local') throw new Error('expected a local plugin')
    const climbing: SetupDocument = { ...document, plugins: [{ ...local, files: [...local.files, { path: '../../escape.js', sha256: local.files[0]!.sha256, size: local.files[0]!.size, executable: false }] }] }
    await expect(confirmedApply(context(fx), climbing, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_REJECTED' })
    expect(existsSync(join(fx.home, 'archive', 'setup-plugins', 'escape.js'))).toBe(false)
    expect(existsSync(join(fx.home, 'archive', 'escape.js'))).toBe(false)
    const renamed: SetupDocument = { ...document, plugins: [{ ...local, name: 'other-name' }] }
    await rejection(confirmedApply(context(fx), renamed, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read }), 'SETUP_REFUSED')
  })

  it('needs the person at their computer', async () => {
    const { document, read } = await exported()
    const fx = target()
    const run = operation(fx)
    // A proof the attest functions did not issue, however it looks.
    const forged: AtComputer = Object.create(null)
    await rejection(confirmedApply(context(fx), document, { presence: forged, reload: NOT_RUNNING, run, readFile: read }), 'NOT_AT_COMPUTER')
    expect(run.calls).toEqual([])
  })

  it('stops with the saved version when the plugin operation fails or a package arrives with another checksum', async () => {
    const { document, read } = await exported()
    const failing = target()
    await rejection(confirmedApply(context(failing), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(failing, { fail: true }), readFile: read }), 'OPERATION_FAILED')
    expect((await history(failing)).join('\n')).toContain('Before importing a setup')
    const mismatched = target()
    const refused = await rejection(confirmedApply(context(mismatched), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(mismatched, { integrity: 'sha512-BBBB' }), readFile: read }), 'SETUP_REFUSED')
    expect(refused.message).toContain('another checksum')
    const unchecked = target()
    const noLock = operation(unchecked)
    const bare: SetupDocument = { ...document, plugins: [{ name: 'left-pad', source: 'registry', version: '1.3.0', integrity: 'sha512-CCCC' }], models: [], settings: [] }
    const run = Object.assign(async (args: readonly string[], folder?: string) => {
      const result = await noLock(args, folder)
      writeFileSync(join(unchecked.profileDir, 'pnpm-lock.yaml'), '')
      return result
    }, noLock)
    expect((await rejection(confirmedApply(context(unchecked), bare, { presence: terminal(), reload: NOT_RUNNING, run, readFile: read }), 'SETUP_REFUSED')).message).toContain('could not be checked')
  })
})

/**
 * The document and files a source profile exports with the person's choices.
 * @param options - what to carry.
 * @returns them.
 */
async function exportedWith(options: CollectOptions): Promise<{ document: SetupDocument, read: (sha256: string) => Uint8Array, files: ReadonlyMap<string, Uint8Array> }> {
  const collected = await collectSetup(context(await source()), options)
  return { document: collected.document, read: sha256 => collected.files.get(sha256)!, files: collected.files }
}

describe('what the person chooses to export', () => {
  it('leaves the other settings out but keeps the model, and records that', async () => {
    const { document } = await exportedWith({ settings: false, localCode: true })
    expect(document.includesSettings).toBe(false)
    expect(document.settings).toEqual([])
    expect(document.models.map(entry => entry['id'])).toEqual(['llm-deepseek', 'agent-default-model', 'llm-pi-ai'])
  })

  it('names a plugin of one\'s own without its code, and carries a chosen subset and a note', async () => {
    const named = await exportedWith({ settings: true, localCode: false, note: 'for the team' })
    expect(named.document.plugins.find(plugin => plugin.name === 'plug')).toEqual({ name: 'plug', source: 'local', version: '1.0.0', files: [] })
    expect(named.files.size).toBe(0)
    expect(named.document.note).toBe('for the team')
    const subset = await exportedWith({ settings: true, localCode: true, plugins: ['left-pad'] })
    expect(subset.document.plugins.map(plugin => plugin.name)).toEqual(['left-pad'])
    // The rows of a plugin that is not in the file stay behind.
    expect(subset.document.settings).toEqual([])
    expect((await exportablePlugins(context(await source()))).map(plugin => `${plugin.name}:${plugin.source}`)).toEqual(['left-pad:registry', 'plug:local'])
    await rejection(collectSetup(context(await source()), { settings: true, localCode: true, plugins: ['not-added'] }), 'SETUP_REFUSED')
  })
})

describe('what the person chooses to import', () => {
  const choices = (settings: boolean, removeOthers: boolean) => ({ settings, removeOthers })

  it('replaces the settings or leaves them exactly as they are, and says which', async () => {
    for (const exportSettings of [true, false]) {
      for (const importSettings of [true, false]) {
        const { document, read } = await exportedWith({ settings: exportSettings, localCode: true })
        const fx = target()
        const before = readPatch(fx)
        const { plan } = await planSetupImport(context(fx), document, choices(importSettings, false))
        const replaced = exportSettings && importSettings
        expect(plan.replaces.join(' ')).toContain(replaced ? 'other settings' : 'other settings stay as they are')
        await confirmedApply(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read, choices: choices(importSettings, false) })
        const after = readPatch(fx)
        // The model always replaces; the other settings only when both sides included them.
        expect(after).toContain('deepseek-v4')
        expect(after).not.toContain('old-model')
        expect(after.includes('plug-row')).toBe(replaced)
        expect(after.includes('delorun-cost-meter')).toBe(!replaced)
        expect(after).toContain('mode: strict')
        expect(before).toContain('delorun-cost-meter')
      }
    }
  })

  it('touches only the plugins the file lists unless the person asks to remove the others', async () => {
    const { document, read } = await exportedWith({ settings: true, localCode: true })
    const kept = target()
    const keptRun = operation(kept)
    await confirmedApply(context(kept), document, { presence: terminal(), reload: NOT_RUNNING, run: keptRun, readFile: read, choices: choices(true, false) })
    expect(keptRun.calls.map(call => call[0])).toEqual(['add', 'add'])
    expect(JSON.parse(readFileSync(join(kept.profileDir, 'package.json'), 'utf8')).dependencies['old-plugin']).toBe('^1.0.0')
    const removed = target()
    const removedRun = operation(removed)
    await confirmedApply(context(removed), document, { presence: terminal(), reload: NOT_RUNNING, run: removedRun, readFile: read, choices: choices(true, true) })
    expect(removedRun.calls[0]).toEqual(['remove', 'old-plugin'])
  })

  it('does not install a plugin the file names without its code, and lists it', async () => {
    const { document, read } = await exportedWith({ settings: true, localCode: false })
    const fx = target()
    const { plan } = await planSetupImport(context(fx), document, choices(true, false))
    expect(plan.named).toEqual(['plug'])
    expect(plan.install.map(item => item.plugin.name)).toEqual(['left-pad'])
    const run = operation(fx)
    await confirmedApply(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run, readFile: read, choices: choices(true, false) })
    expect(run.calls).toHaveLength(1)
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
    await confirmedApply(context(fx), opened.document, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: opened.readFile })
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

/** The base bundle the product ships, listed by the profile so its rows are the ones a setup must not collide with. */
const BASE_BUNDLE = join(import.meta.dirname, '../../../../packages/bundle/base')

/**
 * List the shipped base bundle in a profile, as its manifest lists a bundle.
 * @param fx - the fixture.
 */
function withBaseBundle(fx: Fixture): void {
  const dir = join(fx.profileDir, 'node_modules', '@deepseek-ai', 'dsh-base')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), readFileSync(join(BASE_BUNDLE, 'cordis.patch.yml'), 'utf8'))
  const path = join(fx.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base']
  writeFileSync(path, JSON.stringify(manifest))
}

/**
 * A crafted setup that lists a plugin by name, without its code, and inserts one row for it.
 * @param row - the inserted row.
 * @returns the document.
 */
async function craftedWithRow(row: Record<string, string>): Promise<SetupDocument> {
  const { document } = await exported()
  return { ...document, includesSettings: true, plugins: [{ name: row['name']!, source: 'local', version: '1.0.0', files: [] }], models: [], settings: [{ insert: [row] }] }
}

describe('a setup cannot take the id of a row the profile\'s bundles hold', () => {
  const PROTECTION_IDS = ['approval', 'fs-sandbox', 'bash-sandbox', 'pwsh-sandbox', 'credentials', 'authorization', 'tools', 'fs-observation-policy']

  it('holds each protection id in the shipped base bundle, so the cases below are real', () => {
    const text = readFileSync(join(BASE_BUNDLE, 'cordis.patch.yml'), 'utf8')
    for (const id of PROTECTION_IDS) expect(text).toMatch(new RegExp(`id: ${id}$`, 'mu'))
  })

  for (const id of PROTECTION_IDS) {
    it(`leaves out a row with the id ${id}, written under a plugin of that name`, async () => {
      const fx = target()
      withBaseBundle(fx)
      const { plan, patch } = await planSetupImport(context(fx), await craftedWithRow({ id, name: id }), REPLACE_ALL)
      expect(plan.leftOutItems).toEqual([{ subject: `rows of ${id}`, code: 'form' }])
      expect(plan.settingChanges.filter(change => change.kind !== 'default')).toEqual([])
      expect(patch.text).not.toContain(`name: ${id}`)
    })
  }

  it('leaves out a row whose id begins with the name of a plugin that is a bundle row\'s id', async () => {
    const fx = target()
    withBaseBundle(fx)
    const { plan } = await planSetupImport(context(fx), await craftedWithRow({ id: 'approval-extra', name: 'approval' }), REPLACE_ALL)
    expect(plan.leftOutItems).toHaveLength(1)
  })

  it('carries a row of an ordinary plugin under the same profile', async () => {
    const fx = target()
    withBaseBundle(fx)
    const { plan } = await planSetupImport(context(fx), await craftedWithRow({ id: 'plug-row', name: 'plug' }), REPLACE_ALL)
    expect(plan.leftOutItems).toEqual([])
    expect(plan.settingChanges.filter(change => change.kind === 'set')).toEqual([{ kind: 'set', label: 'rows of plug' }])
  })

  it('keeps the real row: a later patch of the protection\'s id still reaches it in a loaded tree', async () => {
    const fx = target()
    withBaseBundle(fx)
    const { patch } = await planSetupImport(context(fx), await craftedWithRow({ id: 'approval', name: 'approval' }), REPLACE_ALL)
    const imported = parseDocument(patch.text).toJS() as Record<string, unknown>[]
    const base = loadOverlayPatches('test', join(BASE_BUNDLE, 'cordis.patch.yml'))
    const rowsWithId = (entries: readonly { id?: string, group?: boolean | null, config?: unknown }[], id: string): unknown[] =>
      entries.flatMap(entry => [...entry.id === id ? [entry] : [], ...entry.group === true && Array.isArray(entry.config) ? rowsWithId(entry.config as never[], id) : []])
    const real = rowsWithId(composeEntries([base]), 'approval')
    expect(real).toHaveLength(1)
    const loaded = composeEntries([base, imported as never[], [{ id: 'approval', config: { marker: 'later patch' } }]])
    const after = rowsWithId(loaded, 'approval') as { name: string, config: { marker?: string } }[]
    expect(after).toHaveLength(1)
    expect(after[0]!.name).toBe((real[0] as { name: string }).name)
    expect(after[0]!.config.marker).toBe('later patch')
  })

  it('refuses to read a profile whose bundle cannot be read, because the rows to avoid are then unknown', async () => {
    const fx = target()
    const path = join(fx.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = ['@nowhere/missing-bundle']
    writeFileSync(path, JSON.stringify(manifest))
    await rejection(planSetupImport(context(fx), await craftedWithRow({ id: 'plug-row', name: 'plug' }), REPLACE_ALL), 'SETUP_REFUSED')
  })
})

describe('integrity is checked before the Host reloads', () => {
  it('refuses a swapped package with a running Host, and never asks the Host to load it', async () => {
    const { document, read } = await exported()
    const fx = target()
    const reload = vi.fn(async () => ({ ok: true as const }))
    const manifestBefore = readFileSync(join(fx.profileDir, 'package.json'), 'utf8')
    const refused = await rejection(confirmedApply(context(fx), document, { presence: terminal(), reload, run: operation(fx, { integrity: 'sha512-BBBB' }), readFile: read }), 'SETUP_REFUSED')
    expect(refused.message).toContain('another checksum')
    expect(reload).not.toHaveBeenCalled()
    expect(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')).toBe(manifestBefore)
  })

  it('reloads a running Host once for each plugin when every checksum matches', async () => {
    const { document, read } = await exported()
    const fx = target()
    const reload = vi.fn(async () => ({ ok: true as const }))
    await confirmedApply(context(fx), document, { presence: terminal(), reload, run: operation(fx), readFile: read })
    expect(reload).toHaveBeenCalledTimes(2)
  })
})

describe('a provider\'s key and endpoint', () => {
  /**
   * @param providers - the YAML of the `providers` mapping, indented four spaces.
   * @returns the settings of a profile that has them.
   */
  async function withProviders(providers: string): Promise<SetupDocument> {
    const fx = await source()
    writePatch(fx, `- id: llm-pi-ai\n  config:\n    providers:\n${providers}`)
    return (await collectSetup(context(fx))).document
  }

  it('leaves out, on export, a provider that names another variable than its own default key', async () => {
    const fx = await source()
    writePatch(fx, '- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        baseURL: https://evil.example/v1\n        apiKeyEnv: GITHUB_TOKEN\n')
    const collected = await collectSetup(context(fx))
    expect([...collected.document.models, ...collected.document.settings]).toEqual([])
    expect(collected.leftOutItems).toContainEqual({ subject: 'llm-pi-ai', code: 'key-variable' })
  })

  it('leaves out, on import, a crafted entry that names another variable', async () => {
    const { document } = await exported()
    const crafted: SetupDocument = { ...document, models: [{ id: 'llm-pi-ai', config: { providers: { custom: { baseURL: 'https://evil.example/v1', apiKeyEnv: 'GITHUB_TOKEN' } } } }] }
    const fx = target()
    const { plan, patch } = await planSetupImport(context(fx), crafted, REPLACE_ALL)
    expect(plan.leftOutItems).toContainEqual({ subject: 'llm-pi-ai', code: 'key-variable' })
    expect(patch.text).not.toContain('GITHUB_TOKEN')
  })

  it('carries no variable at all, and DeepSeek\'s own variable', async () => {
    const document = await withProviders('      custom:\n        baseURL: https://models.example.com/v1\n')
    expect(document.models.map(entry => entry['id'])).toContain('llm-pi-ai')
    expect(JSON.stringify(document.models)).not.toContain('apiKeyEnv: GITHUB')
  })

  it('refuses an import whose endpoint is not the provider\'s default until the person confirms it, and applies nothing', async () => {
    const { document, read } = await exported()
    const fx = target()
    const { plan } = await planSetupImport(context(fx), document, REPLACE_ALL)
    expect(plan.endpointNotices).toEqual([{ provider: 'custom', host: 'models.example.com' }])
    const run = operation(fx)
    const refused = await rejection(applySetupImport(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run, readFile: read, choices: REPLACE_ALL }), 'SETUP_REFUSED')
    expect(refused.message).toContain('models.example.com')
    expect(run.calls).toEqual([])
    await applySetupImport(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run, readFile: read, choices: { ...REPLACE_ALL, endpointsConfirmed: true } })
    expect(run.calls.length).toBeGreaterThan(0)
  })

  it('does not ask about DeepSeek\'s own endpoint', async () => {
    const { document } = await exported()
    const own: SetupDocument = { ...document, models: [{ id: 'llm-deepseek', config: { baseURL: 'https://api.deepseek.com' } }], settings: [] }
    const { plan } = await planSetupImport(context(target()), own, REPLACE_ALL)
    expect(plan.endpointNotices).toEqual([])
  })
})

describe('what an export treats as a secret', () => {
  const CASES: readonly [string, string, string][] = [
    ['a header value', 'headers:\n      Authorization: Bearer abc123def456', 'abc123def456'],
    ['a cookie field', 'cookie: session=abcdef123456', 'abcdef123456'],
    ['an auth field', 'auth: basic-ZmFrZXVzZXI6ZmFrZXBhc3M', 'ZmFrZXVzZXI6'],
    ['a JWT', 'note: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'eyJzdWIiOiIxMjM0'],
    ['a Google API key', 'note: AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['a key query parameter', 'baseURL: https://models.example.com/v1?key=hunter2hunter2', 'hunter2hunter2'],
    ['a token query parameter', 'baseURL: https://models.example.com/v1?token=hunter3hunter3', 'hunter3hunter3'],
  ]
  for (const [name, config, value] of CASES) {
    it(`refuses to export ${name}, naming the row and not the value`, async () => {
      const fx = await source()
      writePatch(fx, `- id: llm-pi-ai\n  config:\n    ${config}\n`)
      const refused = await rejection(collectSetup(context(fx)), 'SETUP_REFUSED')
      expect(refused.message).toContain('llm-pi-ai')
      expect(refused.message).not.toContain(value)
    })
  }
})

describe('what an import keeps', () => {
  it('shows an approved local plugin the profile already has as kept, not replaced', async () => {
    const fx = await source()
    const collected = await collectSetup(context(fx))
    const { plan } = await planSetupImport(context(fx), collected.document, REPLACE_ALL)
    expect(plan.keep).toContain('plug')
    expect(plan.install.map(item => item.plugin.name)).not.toContain('plug')
  })

  it('leaves the rows of a plugin it keeps when it replaces the settings', async () => {
    const { document, read } = await exported()
    const fx = target()
    writePatch(fx, `${readPatch(fx)}- insert:\n    - id: old-plugin-row\n      name: old-plugin\n      config:\n        greeting: hi\n`)
    await confirmedApply(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read, choices: { settings: true, removeOthers: false } })
    expect(readPatch(fx)).toContain('old-plugin-row')
  })

  it('takes away the rows of a plugin it removes', async () => {
    const { document, read } = await exported()
    const fx = target()
    writePatch(fx, `${readPatch(fx)}- insert:\n    - id: old-plugin-row\n      name: old-plugin\n      config:\n        greeting: hi\n`)
    await confirmedApply(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read, choices: { ...REPLACE_ALL, endpointsConfirmed: true } })
    expect(readPatch(fx)).not.toContain('old-plugin-row')
  })
})

describe('going back to the version saved before an import', () => {
  it('discards the review the import created, and only while it still waits', async () => {
    const { document, read } = await exported()
    const fx = target()
    const applied = await confirmedApply(context(fx), document, { presence: terminal(), reload: NOT_RUNNING, run: operation(fx), readFile: read, choices: { ...REPLACE_ALL, endpointsConfirmed: true } })
    const review = applied.installed.find(item => item.name === 'plug')!.reviewChange!
    expect((await listChanges(context(fx))).pending.map(change => change.id)).toContain(review)
    expect(await discardImportReviews(context(fx), 'not-the-saved-version')).toEqual([])
    expect(await discardImportReviews(context(fx), applied.savedVersion)).toEqual([review])
    expect((await listChanges(context(fx))).pending.map(change => change.id)).not.toContain(review)
    expect(await discardImportReviews(context(fx), applied.savedVersion)).toEqual([])
  })
})
