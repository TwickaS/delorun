/**
 * The default workspace step of `delorun start`: the documents lookup each platform runs, the choice between the
 * documents folder and the home directory, the refusal of folders no workspace may be, and the failure that names the
 * row setting a person uses instead. Every home is a temporary directory, and nothing is created under it.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { workspaceLocationHomes, workspaceLocationMessage, type WorkspaceLocationHomes } from '@delo/home'
import { CliError } from '../src/exit.ts'
import {
  DEFAULT_WORKSPACE_SEGMENTS,
  defaultWorkspaceRequest,
  lookupDocumentsDirectory,
  profileConfiguresWorkspaceRow,
  resolveDefaultWorkspace,
  type DefaultWorkspaceRequest,
} from '../src/default-workspace.ts'

const POSIX = process.platform !== 'win32'

let root: string
let osHome: string
let documents: string
let homes: WorkspaceLocationHomes
let patchPath: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-default-workspace-')))
  osHome = join(root, 'home')
  documents = join(osHome, 'Documents')
  mkdirSync(documents, { recursive: true })
  homes = { osHome, deloHome: join(osHome, '.delo'), stockHome: join(osHome, '.dsh') }
  patchPath = join(root, 'cordis.patch.yml')
  writeFileSync(patchPath, '[]\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * A request over the temporary homes.
 * @param found - what the documents lookup reports.
 * @param overrides - fields to replace.
 * @returns the request.
 */
function request(found: string | undefined, overrides: Partial<DefaultWorkspaceRequest> = {}): DefaultWorkspaceRequest {
  return {
    platform: process.platform,
    homes,
    tempDirectory: join(root, 'tmp'),
    profilePatchPath: patchPath,
    profileConfiguresRow: false,
    documents: () => Promise.resolve(found),
    ...overrides,
  }
}

const under = (base: string): string => join(base, ...DEFAULT_WORKSPACE_SEGMENTS)

describe('lookupDocumentsDirectory', () => {
  /**
   * A runner that records its command and prints one output.
   * @param stdout - what the command prints.
   * @param seen - collects each command and its arguments.
   * @returns the runner.
   */
  function printing(stdout: string, seen: (readonly [string, readonly string[], string])[]): NativeCommandRunner {
    return (command, args, _signal, window) => {
      seen.push([command, args, window])
      return Promise.resolve({ stdout, stderr: '' })
    }
  }

  it('runs each platform\'s lookup, hidden, and returns its output without the trailing line break', async () => {
    const seen: (readonly [string, readonly string[], string])[] = []
    expect(await lookupDocumentsDirectory('linux', 1000, printing('/home/a/Documents\n', seen))).toBe('/home/a/Documents')
    expect(await lookupDocumentsDirectory('darwin', 1000, printing('/Users/a/Documents/\n', seen))).toBe('/Users/a/Documents/')
    expect(await lookupDocumentsDirectory('win32', 1000, printing('C:\\Users\\a\\Documents\r\n', seen))).toBe('C:\\Users\\a\\Documents')
    expect(seen.map(([command, args, window]) => [command, args[0], args.at(-1)?.includes('MyDocuments') ?? false, window])).toEqual([
      ['xdg-user-dir', 'DOCUMENTS', false, 'hidden'],
      ['osascript', '-e', false, 'hidden'],
      ['powershell.exe', '-NoLogo', true, 'hidden'],
    ])
    expect(seen[1]?.[1]).toEqual(['-e', 'POSIX path of (path to documents folder from user domain without folder creation)'])
  })

  it('reports no folder on a platform without a lookup, for empty output, and when the command fails or times out', async () => {
    const seen: (readonly [string, readonly string[], string])[] = []
    expect(await lookupDocumentsDirectory('freebsd', 1000, printing('/x', seen))).toBeUndefined()
    expect(seen).toEqual([])
    expect(await lookupDocumentsDirectory('linux', 1000, printing('\n', seen))).toBeUndefined()
    expect(await lookupDocumentsDirectory('linux', 1000, () => Promise.reject(Object.assign(new Error('spawn xdg-user-dir ENOENT'), { code: 'ENOENT' })))).toBeUndefined()
    const waiting: NativeCommandRunner = (_command, _args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason as Error) })
    })
    expect(await lookupDocumentsDirectory('linux', 5, waiting)).toBeUndefined()
  })
})

describe.skipIf(!POSIX)('resolveDefaultWorkspace', () => {
  it('places the workspace under the documents folder when the lookup reports one other than the home', async () => {
    expect(await resolveDefaultWorkspace(request(documents))).toEqual({ kind: 'resolved', base: 'documents', directory: join(documents, 'Delo', 'default-workspace') })
  })

  it('places it under the home when the lookup reports the home, reports nothing, or reports a relative path', async () => {
    const home = { kind: 'resolved', base: 'home', directory: under(osHome) }
    expect(await resolveDefaultWorkspace(request(`${osHome}/`))).toEqual(home)
    expect(await resolveDefaultWorkspace(request(undefined))).toEqual(home)
    expect(await resolveDefaultWorkspace(request('Documents'))).toEqual(home)
    // macOS and Windows compare folders without case.
    expect(await resolveDefaultWorkspace(request(osHome.toUpperCase(), { platform: 'darwin' }))).toEqual(home)
  })

  it('uses the home when the documents candidate lies inside the Delo home, the stock home, or contains the temporary folder', async () => {
    const home = { kind: 'resolved', base: 'home', directory: under(osHome) }
    expect(await resolveDefaultWorkspace(request(documents, { homes: { ...homes, deloHome: join(documents, 'Delo') } }))).toEqual(home)
    expect(await resolveDefaultWorkspace(request(documents, { homes: { ...homes, stockHome: under(documents) } }))).toEqual(home)
    const temp = join(under(documents), 'tmp')
    mkdirSync(temp, { recursive: true })
    expect(await resolveDefaultWorkspace(request(documents, { tempDirectory: temp }))).toEqual(home)
    expect(await resolveDefaultWorkspace(request(documents, { tempDirectory: under(documents) }))).toEqual(home)
    // An existing candidate beside the temporary folder, and a temporary folder that does not exist, hold nothing.
    mkdirSync(join(root, 'tmp'))
    expect(await resolveDefaultWorkspace(request(documents))).toMatchObject({ base: 'documents' })
    expect(await resolveDefaultWorkspace(request(documents, { tempDirectory: join(root, 'missing') }))).toMatchObject({ base: 'documents' })
  })

  it('fails loud when every candidate is refused, naming each reason and the row setting that chooses the folder', async () => {
    const both = request(documents, { homes: { ...homes, stockHome: join(documents, 'Delo'), deloHome: join(osHome, 'Delo') } })
    const failure = await resolveDefaultWorkspace(both).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(CliError)
    expect((failure as CliError).exit).toBe(1)
    expect((failure as CliError).message.split('\n')).toEqual([
      'delorun: Delorun found no folder for the default workspace.',
      `${under(documents)}: ${workspaceLocationMessage('stock-home')}`,
      `${under(osHome)}: ${workspaceLocationMessage('delo-home')}`,
      `Choose one in ${patchPath}: add the row \`- id: workspace-controller\` with \`config: { defaultWorkspaceDirectory: <a folder of your own> }\`, then start again.`,
    ])
    const temp = join(under(osHome), 'tmp')
    mkdirSync(temp, { recursive: true })
    await expect(resolveDefaultWorkspace(request(undefined, { tempDirectory: temp }))).rejects.toThrow('contains the temporary folder')
  })

  it('joins Windows paths with Windows separators', async () => {
    // On this host a drive path is not absolute, so both candidates are refused and the failure names their spelling.
    const windows = request('C:\\Users\\a\\Documents\\', { platform: 'win32', homes: { ...homes, osHome: 'C:\\Users\\a' } })
    const failure = await resolveDefaultWorkspace(windows).then(() => undefined, (error: unknown) => error)
    expect((failure as CliError).message).toContain(`C:\\Users\\a\\Documents\\Delo\\default-workspace: ${workspaceLocationMessage('not-absolute')}`)
    expect((failure as CliError).message).toContain('C:\\Users\\a\\Delo\\default-workspace: ')
    const same = request('c:\\users\\A\\', { platform: 'win32', homes: { ...homes, osHome: 'C:\\Users\\a' } })
    const sameFailure = await resolveDefaultWorkspace(same).then(() => undefined, (error: unknown) => error)
    expect((sameFailure as CliError).message).not.toContain('Documents')
  })

  it('resolves nothing when the profile\'s own patch configures the row, and runs no lookup', async () => {
    let looked = false
    const spec = await resolveDefaultWorkspace(request(documents, { profileConfiguresRow: true, documents: () => { looked = true; return Promise.resolve(documents) } }))
    expect(spec).toEqual({ kind: 'profile' })
    expect(looked).toBe(false)
  })

  it('creates nothing on disk', async () => {
    await resolveDefaultWorkspace(request(documents))
    await resolveDefaultWorkspace(request(undefined))
    expect(existsSync(join(documents, 'Delo'))).toBe(false)
    expect(existsSync(join(osHome, 'Delo'))).toBe(false)
  })
})

describe('the request of a start', () => {
  it('reads whether the profile\'s own patch configures the workspace-controller row', () => {
    expect(profileConfiguresWorkspaceRow(patchPath)).toBe(false)
    writeFileSync(patchPath, '- id: workspace-controller\n  disabled: true\n')
    expect(profileConfiguresWorkspaceRow(patchPath)).toBe(false)
    writeFileSync(patchPath, '- id: workspace-controller\n  config:\n    defaultWorkspaceDirectory: /srv/work\n')
    expect(profileConfiguresWorkspaceRow(patchPath)).toBe(true)
  })

  it('holds this process\'s platform, homes and temporary folder, and runs the platform\'s lookup', async () => {
    const deloHome = join(osHome, '.delo')
    const built = defaultWorkspaceRequest(deloHome, patchPath)
    expect(built).toMatchObject({ platform: process.platform, homes: workspaceLocationHomes(deloHome), tempDirectory: tmpdir(), profilePatchPath: patchPath, profileConfiguresRow: false })
    const found = await built.documents()
    expect(found === undefined || typeof found === 'string').toBe(true)
  })
})
