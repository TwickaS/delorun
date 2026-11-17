/**
 * `delorun setup export` and `delorun setup import` over two scratch homes. The export writes a signed archive that
 * holds the plugins and the model and plugin settings and nothing of a computer; the import of it into another home
 * shows an unknown signer as unverified with its fingerprint, lists everything it would remove or change, asks, and
 * applies through Changes' plugin requests. Each refusal is a denial case: no terminal, no yes, a chats archive, a
 * changed byte, a file that exists, a key in a settings row.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchiveImporter, DirectoryWorkspaceStore, exportArchive, exportSetupArchive, loadHomeKey, ZipArchive } from '@delorun/archive'
import { attestTerminal, enforceApprovedContent, listChanges, readApproved, setProtection, type ReloadHost } from '@delorun/changes'
import { ensureHomeTree } from '@delorun/home'
import { runImport } from '../src/import/index.ts'
import type { ChangesCommandDependencies } from '../src/changes/command.ts'
import type { CommandContext } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { setupCommand } from '../src/setup/index.ts'
import { runSetupTransfer } from '../src/changes/setup-transfer.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const PROFILE = 'default'
const TERMINAL = { stdin: { isTTY: true }, stdout: { isTTY: true } }
const NOT_RUNNING: ReloadHost = async () => undefined

const SOURCE_PATCH = `- id: llm-deepseek
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
- insert:
    - id: plug-row
      name: plug
      config:
        greeting: hello
`

let base: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-setup-transfer-')))
  vi.stubEnv('HOME', base)
  vi.stubEnv('USERPROFILE', base)
  vi.stubEnv('DSH_HOME', join(base, '.dsh'))
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

/** One home under test with the context and output of a command run in it. */
interface World {
  readonly home: string
  readonly profileDir: string
  readonly printed: string[]
  readonly context: CommandContext
}

/**
 * A home with the CLI profile, one registry plugin installed, and, for the source, a plugin made here and approved.
 * @param name - the home's directory name.
 * @param source - whether to give it the plugin made here and the source patch.
 * @returns the home.
 */
async function world(name: string, source: boolean): Promise<World> {
  const home = join(base, name)
  const profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(home, { mode: 0o700 })
  await ensureHomeTree(home, PROFILE)
  await setProtection(home, 'on', attestTerminal(TERMINAL))
  mkdirSync(join(profileDir, 'node_modules', source ? 'left-pad' : 'old-plugin'), { recursive: true })
  const dependencies: Record<string, string> = source ? { 'left-pad': '1.3.0' } : { 'old-plugin': '1.0.0' }
  writeFileSync(join(profileDir, 'node_modules', source ? 'left-pad' : 'old-plugin', 'package.json'), JSON.stringify({ name: source ? 'left-pad' : 'old-plugin', version: source ? '1.3.0' : '1.0.0' }))
  if (source) {
    const folder = join(base, 'plug')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
    writeFileSync(join(folder, 'index.js'), 'export default 1\n')
    dependencies['plug'] = `link:${folder}`
  }
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dependencies, dsh: { profile: { bundles: [] } } }, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), source ? SOURCE_PATCH : '- id: llm-deepseek\n  config:\n    model: old-model\n- id: sandbox-policy\n  config:\n    mode: strict\n')
  if (source) await enforceApprovedContent({ home, profile: PROFILE, profileDir })
  const printed: string[] = []
  return { home, profileDir, printed, context: { env: { HOME: base, DSH_HOME: join(base, '.dsh'), DELORUN_HOME: home }, stdout: text => void printed.push(text), stderr: () => {}, printed } as CommandContext & { printed: string[] } }
}

/** What a driven terminal did. */
interface Driven extends ChangesCommandDependencies {
  readonly questions: string[]
  readonly operations: (readonly string[])[]
}

/**
 * A terminal that answers in order, a Host that is not running, and a plugin operation that edits the manifest as pnpm does.
 * @param answers - the answers.
 * @param profileDir - the profile whose manifest the operation edits.
 * @param tty - whether input and output are terminals.
 * @returns the dependencies.
 */
function driven(answers: readonly string[], profileDir: string, tty = true): Driven {
  const queue = [...answers]
  const questions: string[] = []
  const operations: (readonly string[])[] = []
  return {
    streams: { stdin: { isTTY: tty }, stdout: { isTTY: tty } },
    ask: async (question) => {
      questions.push(question)
      return queue.shift() ?? ''
    },
    withHost: async (_home, _profile, run) => run(NOT_RUNNING),
    harness: () => undefined,
    pluginOperation: () => async (args) => {
      operations.push(args)
      const path = join(profileDir, 'package.json')
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }
      if (args[0] === 'remove') delete manifest.dependencies[args[1]!]
      else {
        const at = args[1]!.lastIndexOf('@')
        manifest.dependencies[args[1]!.slice(0, at)] = args[1]!.slice(at + 1)
      }
      writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
      return { exitCode: 0 }
    },
    questions,
    operations,
  }
}

/**
 * Export the source's setup.
 * @param source - the source home.
 * @param file - the archive's name.
 * @returns the archive's path.
 */
async function exportFrom(source: World, file = 'setup.delorun'): Promise<string> {
  const out = join(base, file)
  expect(await runSetupTransfer(['export', '--out', out], source.context, driven([], source.profileDir))).toBe(EXIT.ok)
  return out
}

/**
 * @param promise - a command run that must be refused.
 * @returns the refusal.
 */
async function refused(promise: Promise<unknown>): Promise<CliError> {
  const error: unknown = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(CliError)
  return error as CliError
}

describe('delorun setup export', () => {
  it('writes a signed archive that holds the plugins and the carried settings, and says what it left out', async () => {
    const source = await world('source', true)
    const out = await exportFrom(source)
    expect(statSync(out).mode & 0o777).toBe(0o600)
    const text = source.printed.join('')
    expect(text).toContain('2 plugins (1 made on this computer, carried with their files), 2 model entries and 1 other settings')
    expect(text).toContain('Signed by this home\'s key, fingerprint ')
    expect(text).toContain('sandbox-policy')
    expect(text).toContain('holds no key, chat, device or setup answer')
    const opened = new ArchiveImporter({ stagingParent: join(base, 'st'), store: new DirectoryWorkspaceStore(join(base, 'store')), trustedPublicKeys: [(await loadHomeKey(source.home))!.publicKey] }).openSetup(new Uint8Array(readFileSync(out)))
    expect(opened.state).toBe('verified')
    expect(JSON.stringify(opened.document)).not.toContain('"mode":"off"')
    // The archive's entries are the container, the document and the plugin's two files, and nothing of the home.
    expect(ZipArchive.open(new Uint8Array(readFileSync(out))).names().filter(name => name.startsWith('objects/')).length).toBe(3)
  })

  it('leaves out the other settings, chooses plugins, names own plugins without code, and carries a note', async () => {
    const source = await world('source', true)
    const quiet = join(base, 'quiet.delorun')
    expect(await runSetupTransfer(['export', '--out', quiet, '--no-settings', '--no-local-code', '--plugin', 'plug', '--note', 'hello'], source.context, driven([], source.profileDir))).toBe(EXIT.ok)
    const text = source.printed.join('')
    expect(text).toContain('1 plugin (1 made on this computer)')
    expect(text).toContain('no other settings')
    expect(text).toContain('Named without their code, to copy yourself: plug')
    const opened = new ArchiveImporter({ stagingParent: join(base, 'st'), store: new DirectoryWorkspaceStore(join(base, 'store')), trustedPublicKeys: [] }).openSetup(new Uint8Array(readFileSync(quiet)))
    expect(opened.document).toMatchObject({ includesSettings: false, settings: [], note: 'hello', plugins: [{ name: 'plug', files: [] }] })
    expect((await refused(runSetupTransfer(['export', '--out', join(base, 'x'), '--plugin', 'not-added'], source.context, driven([], source.profileDir)))).message).toContain('not-added')
    expect((await refused(runSetupTransfer(['import', quiet, '--note', 'x'], source.context, driven([], source.profileDir)))).message).toContain('Usage')
  })

  it('refuses an existing file, a missing --out and a settings row that holds a key, and writes nothing', async () => {
    const source = await world('source', true)
    const out = await exportFrom(source)
    expect((await refused(runSetupTransfer(['export', '--out', out], source.context, driven([], source.profileDir)))).message).toContain('exists')
    expect((await refused(runSetupTransfer(['export'], source.context, driven([], source.profileDir)))).message).toContain('Usage: delorun setup export')
    writeFileSync(join(source.profileDir, 'cordis.patch.yml'), '- id: llm-deepseek\n  config:\n    apiKey: not-a-real-secret-value\n')
    const other = join(base, 'second.delorun')
    const error = await refused(runSetupTransfer(['export', '--out', other], source.context, driven([], source.profileDir)))
    expect(error.message).toContain('llm-deepseek')
    expect(error.message).not.toContain('not-a-real-secret-value')
    expect(existsSync(other)).toBe(false)
  })

  it('is reached through delorun setup and refuses a missing --out there too', async () => {
    const source = await world('source', true)
    const error = await refused(setupCommand.run(['export'], source.context))
    expect(error.message).toContain('Usage: delorun setup export')
  })
})

describe('delorun setup import', () => {
  it('shows an unknown signer as unverified with its fingerprint and every removal, and changes nothing with --dry-run', async () => {
    const source = await world('source', true)
    const archive = await exportFrom(source)
    const target = await world('target', false)
    const before = readFileSync(join(target.profileDir, 'package.json'), 'utf8')
    const deps = driven([], target.profileDir, false)
    expect(await runSetupTransfer(['import', archive, '--dry-run', '--remove-others'], target.context, deps)).toBe(EXIT.ok)
    const text = target.printed.join('')
    expect(text).toContain('! Unverified signer · ')
    expect((await loadHomeKey(source.home))!.keyId.length).toBeGreaterThan(10)
    expect(text).toContain('replaces these parts of your profile default')
    expect(text).toContain('- old-plugin')
    expect(text).toContain('plug 1.0.0, made on another computer; its code waits for your review')
    expect(text).toContain('Protection is on')
    expect(text).toContain('Dry run: nothing was changed.')
    expect(deps.questions).toEqual([])
    expect(readFileSync(join(target.profileDir, 'package.json'), 'utf8')).toBe(before)
  })

  it('replaces the setup after a yes, holds the plugin\'s code for review, and says how to go back and what key is needed', async () => {
    const source = await world('source', true)
    const archive = await exportFrom(source)
    const target = await world('target', false)
    const deps = driven(['y'], target.profileDir)
    expect(await runSetupTransfer(['import', archive, '--remove-others'], target.context, deps)).toBe(EXIT.ok)
    expect(deps.questions).toEqual(['Replace the setup of the profile default with this one? [y/N] '])
    expect(deps.operations.map(args => args[0])).toEqual(['remove', 'add', 'add'])
    const manifest = JSON.parse(readFileSync(join(target.profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['left-pad', 'plug'])
    expect((await readApproved(target.profileDir)).plugins['plug']).toBeUndefined()
    const pending = (await listChanges({ home: target.home, profile: PROFILE, profileDir: target.profileDir })).pending
    expect(pending.map(change => change.plugin)).toContain('plug')
    const patch = readFileSync(join(target.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('mode: strict')
    expect(patch).not.toContain('old-model')
    expect(patch).toContain('deepseek-v4')
    expect(patch).not.toContain('mode: off')
    const text = target.printed.join('')
    expect(text).toContain('Saved your current setup as the version "Before importing a setup"')
    expect(text).toContain('delorun recover restore')
    expect(text).toContain('delorun changes show')
    expect(text).toContain('Add its key with delorun setup key')
  })

  it('asks about an endpoint that is not the provider\'s default separately, and changes nothing when it is declined', async () => {
    const source = await world('source', true)
    writeFileSync(join(source.profileDir, 'cordis.patch.yml'), `${SOURCE_PATCH}- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        baseURL: https://models.example.com/v1\n`)
    const archive = await exportFrom(source)
    const target = await world('target', false)
    const before = readFileSync(join(target.profileDir, 'package.json'), 'utf8')
    const declined = driven(['y', 'n'], target.profileDir)
    expect((await refused(runSetupTransfer(['import', archive], target.context, declined))).message).toContain('nothing was changed')
    expect(declined.questions[1]).toBe('Requests and your custom key will go to models.example.com. Allow that? [y/N] ')
    expect(declined.operations).toEqual([])
    expect(readFileSync(join(target.profileDir, 'package.json'), 'utf8')).toBe(before)
    const allowed = driven(['y', 'y'], target.profileDir)
    expect(await runSetupTransfer(['import', archive], target.context, allowed)).toBe(EXIT.ok)
    expect(allowed.operations.length).toBeGreaterThan(0)
  })

  it('leaves the other plugins and the other settings alone when asked, and shows the sender\'s note', async () => {
    const source = await world('source', true)
    const out = join(base, 'note.delorun')
    expect(await runSetupTransfer(['export', '--out', out, '--note', 'my work setup'], source.context, driven([], source.profileDir))).toBe(EXIT.ok)
    const target = await world('target', false)
    const deps = driven(['y'], target.profileDir)
    expect(await runSetupTransfer(['import', out, '--no-settings'], target.context, deps)).toBe(EXIT.ok)
    const text = target.printed.join('')
    expect(text).toContain('Note from the sender: "my work setup"')
    expect(text).toContain('other settings stay as they are')
    // Without --remove-others the plugin the file does not list stays; without settings only the model is replaced.
    expect(deps.operations.map(args => args[0])).toEqual(['add', 'add'])
    expect(Object.keys((JSON.parse(readFileSync(join(target.profileDir, 'package.json'), 'utf8')) as { dependencies: object }).dependencies).sort()).toEqual(['left-pad', 'old-plugin', 'plug'])
    const patch = readFileSync(join(target.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('deepseek-v4')
    expect(patch).not.toContain('plug-row')
  })

  it('imports nothing without a yes and needs a terminal', async () => {
    const source = await world('source', true)
    const archive = await exportFrom(source)
    const target = await world('target', false)
    const before = readFileSync(join(target.profileDir, 'package.json'), 'utf8')
    for (const answer of ['', 'n', 'unverified']) {
      expect((await refused(runSetupTransfer(['import', archive], target.context, driven([answer], target.profileDir)))).message).toContain('nothing was changed')
    }
    const noTerminal = await refused(runSetupTransfer(['import', archive], target.context, driven(['y'], target.profileDir, false)))
    expect(noTerminal.message).toContain('This needs you at your computer')
    expect(readFileSync(join(target.profileDir, 'package.json'), 'utf8')).toBe(before)
  })

  it('shows an unsigned archive as unverified and still asks', async () => {
    const source = await world('source', true)
    const target = await world('target', false)
    const key = (await loadHomeKey(source.home, { create: true }))!
    const unsigned = join(base, 'unsigned.delorun')
    writeFileSync(unsigned, exportSetupArchive({ createdBy: 'test', origin: { homeKeyId: key.keyId, publicKey: key.publicKey }, document: { schemaVersion: 1, profile: 'p', includesSettings: true, plugins: [], models: [], settings: [] }, files: new Map() }))
    const deps = driven(['n'], target.profileDir)
    await refused(runSetupTransfer(['import', unsigned], target.context, deps))
    expect(target.printed.join('')).toContain('! Unsigned: this file is not signed')
    expect(deps.questions).toHaveLength(1)
  })

  it('says there is nothing to do when the profile already has the setup', async () => {
    const source = await world('source', true)
    const key = (await loadHomeKey(source.home, { create: true }))!
    const empty = join(base, 'empty.delorun')
    writeFileSync(empty, exportSetupArchive({ createdBy: 'test', origin: { homeKeyId: key.keyId, publicKey: key.publicKey }, document: { schemaVersion: 1, profile: 'p', includesSettings: true, plugins: [], models: [], settings: [] }, files: new Map() }))
    const target = await world('bare', false)
    writeFileSync(join(target.profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } })}\n`)
    writeFileSync(join(target.profileDir, 'cordis.patch.yml'), '[]\n')
    const deps = driven([], target.profileDir)
    expect(await runSetupTransfer(['import', empty], target.context, deps)).toBe(EXIT.ok)
    expect(target.printed.join('')).toContain('Nothing to do')
    expect(deps.questions).toEqual([])
  })

  it('refuses a chats archive here and a setup archive at delorun import, a changed byte, and a missing profile', async () => {
    const source = await world('source', true)
    const archive = await exportFrom(source)
    const target = await world('target', false)
    const io = { home: target.home, stdout: () => {}, ask: async () => 'y', exclusive: async <T>(run: () => Promise<T>) => run() }
    const wrongWay = await refused(runImport([archive], io))
    expect(wrongWay.message).toContain('ARCHIVE_WRONG_KIND')
    expect(wrongWay.message).toContain('delorun setup import')
    const key = (await loadHomeKey(source.home, { create: true }))!
    const chats = join(base, 'chats.zip')
    const result = exportArchive({
      createdBy: 'test', origin: { homeKeyId: key.keyId, publicKey: key.publicKey }, customisation: { schemaVersion: 1, rows: [] },
      workspaces: [{ id: 'w', name: 'w', entity: new TextEncoder().encode('{}'), chats: [{ id: 'c', text: 'hello' }], attachments: [] }],
    })
    writeFileSync(chats, result.bytes!)
    const otherWay = await refused(runSetupTransfer(['import', chats], target.context, driven(['y'], target.profileDir)))
    expect(otherWay.message).toContain('ARCHIVE_WRONG_KIND')
    expect(otherWay.message).toContain('delorun import')
    const bytes = new Uint8Array(readFileSync(archive))
    bytes[Math.floor(bytes.length / 3)] = (bytes[Math.floor(bytes.length / 3)]! + 1) % 256
    const damaged = join(base, 'damaged.delorun')
    writeFileSync(damaged, bytes)
    const refusal = await refused(runSetupTransfer(['import', damaged], target.context, driven(['y'], target.profileDir)))
    expect(refusal.message).toContain('the archive is refused')
    expect(refusal.message).toContain('nothing was changed')
    rmSync(join(target.profileDir, 'package.json'))
    expect((await refused(runSetupTransfer(['import', archive], target.context, driven([], target.profileDir)))).message).toContain('not set up')
  })

  it('refuses a usage that is wrong', async () => {
    const source = await world('source', true)
    expect((await refused(runSetupTransfer(['import'], source.context, driven([], source.profileDir)))).message).toContain('Usage: delorun setup export')
    expect((await refused(runSetupTransfer(['import', 'a', 'b'], source.context, driven([], source.profileDir)))).message).toContain('Usage: delorun setup export')
    expect((await refused(runSetupTransfer(['export', 'file.dsh'], source.context, driven([], source.profileDir)))).message).toBe('--out is missing: delorun setup export --out <file>')
    expect((await refused(runSetupTransfer(['import', 'a', '--bogus'], source.context, driven([], source.profileDir)))).message).toContain('bogus')
  })
})
