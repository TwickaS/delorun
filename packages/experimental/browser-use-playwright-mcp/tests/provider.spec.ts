import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { chromeChannelCandidates, launchedBrowser } from '@deepseek-ai/dsh-native-command/chrome-channel'
import * as Provider from '../src/index.ts'

const CHROME = '/opt/google/chrome/chrome'
const computer = vi.hoisted(() => ({ chromeInstalled: false }))

// The real choice logic, reading a Linux computer whose Chrome the spec installs or removes.
vi.mock('@deepseek-ai/dsh-native-command/chrome-channel', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-native-command/chrome-channel')>()
  return {
    ...original,
    launchedBrowser: vi.fn((choice: Parameters<typeof original.launchedBrowser>[0], _host?: unknown, executable?: string) =>
      original.launchedBrowser(choice, { platform: 'linux', env: {}, exists: path => computer.chromeInstalled && path === CHROME }, executable)),
  }
})

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
const scratch: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(scratch.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

/** A chat's folder and a folder outside it, both real paths. */
async function chatFolder(): Promise<{ chat: string; outside: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-playwright-guard-')))
  scratch.push(root)
  const chat = join(root, 'chat'), outside = join(root, 'outside')
  await Promise.all([mkdir(chat), mkdir(outside)])
  return { chat, outside }
}

/** The server arguments, after the CLI path, that a configuration starts on a computer with or without Chrome installed. */
function launchArgs(config: Parameters<typeof Provider.Config>[0], chromeInstalled: boolean): string[] {
  computer.chromeInstalled = chromeInstalled
  Provider.apply(new Context(), Provider.Config(config))
  return vi.mocked(mountSessionMcp).mock.calls.at(-1)![1].args.slice(1)
}

it('uses the pinned Playwright executable with isolated Chromium launch settings', () => {
  vi.stubEnv('PLAYWRIGHT_MCP_CDP_ENDPOINT', 'http://invalid.example:1')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', executablePath: '/custom/chromium', toolCallTimeoutMs: 123 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'playwright-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 123 })
  expect(options.env?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe('')
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/custom/chromium'])
  expect(options.args).toHaveLength(7)
  expect('default' in Provider).toBe(false)
})

it('supports headed launch and attaches without launching a browser or creating a profile', () => {
  expect(launchArgs({ mode: 'launch', headless: false }, false)).toEqual(['--browser', 'chromium', '--isolated'])
  expect(launchArgs({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }, true)).toEqual(['--browser', 'chromium', '--cdp-endpoint', 'http://127.0.0.1:9222'])
  expect(vi.mocked(mountSessionMcp).mock.calls[1]![1].exclusive).toBe(true)
})

it('defaults browser to auto, which launches the installed Chrome in an isolated profile and Chromium when there is none', () => {
  expect(Provider.Config({ mode: 'launch' })).toMatchObject({ browser: 'auto' })
  expect(launchArgs({ mode: 'launch' }, true)).toEqual(['--browser', 'chrome', '--isolated', '--headless'])
  expect(launchArgs({ mode: 'launch', browser: 'auto' }, false)).toEqual(['--browser', 'chromium', '--isolated', '--headless'])
})

it('launches the forced browser whether or not Chrome is installed, and rejects any other browser', () => {
  for (const installed of [true, false]) {
    expect(launchArgs({ mode: 'launch', browser: 'chrome' }, installed)).toEqual(['--browser', 'chrome', '--isolated', '--headless'])
    expect(launchArgs({ mode: 'launch', browser: 'chromium' }, installed)).toEqual(['--browser', 'chromium', '--isolated', '--headless'])
  }
  expect(vi.mocked(launchedBrowser).mock.calls.map(([choice]) => choice)).toEqual(['chrome', 'chromium', 'chrome', 'chromium'])
  expect(() => Provider.Config({ mode: 'launch', browser: 'firefox' } as never)).toThrow()
})

it('keeps Chromium launch settings for a configured executable under auto, and the same arguments on every start', () => {
  expect(launchArgs({ mode: 'launch', executablePath: '/custom/chromium' }, true))
    .toEqual(['--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/custom/chromium'])
  expect(launchArgs({ mode: 'launch', browser: 'chrome', executablePath: '/custom/chrome' }, false))
    .toEqual(['--browser', 'chrome', '--isolated', '--headless', '--executable-path', '/custom/chrome'])
  expect(launchArgs({ mode: 'launch' }, true)).toEqual(launchArgs({ mode: 'launch' }, true))
})

it('lists the Chrome paths that the pinned Playwright\'s own chrome channel tries on each platform', () => {
  const require = createRequire(import.meta.url)
  const mcp = createRequire(require.resolve('@playwright/mcp/package.json'))
  const { registry } = mcp('playwright-core/lib/coreBundle') as {
    registry: { registry: { findExecutable(name: string): { executablePath(): string | undefined } } }
  }
  const fs = require('node:fs') as typeof import('node:fs')
  const hosts: { platform: NodeJS.Platform; env: Record<string, string> }[] = [
    { platform: 'linux', env: {} },
    { platform: 'darwin', env: {} },
    { platform: 'win32', env: {
      LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', HOMEDRIVE: 'C:',
    } },
    { platform: 'win32', env: { LOCALAPPDATA: '', PROGRAMFILES: 'D:\\Programs', 'PROGRAMFILES(X86)': '', HOMEDRIVE: 'D:' } },
  ]
  for (const host of hosts) {
    for (const name of ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'HOMEDRIVE']) vi.stubEnv(name, host.env[name] ?? '')
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue(host.platform)
    const tried: string[] = []
    const access = vi.spyOn(fs, 'accessSync').mockImplementation((path) => {
      tried.push(String(path))
      throw new Error('absent')
    })
    try {
      expect(registry.registry.findExecutable('chrome').executablePath()).toBeUndefined()
    } finally {
      access.mockRestore()
      platform.mockRestore()
    }
    // Playwright joins with this computer's separator; on Windows that is the win32 join the candidates use.
    const normal = (path: string): string => host.platform === 'win32' ? win32.normalize(path) : path
    expect(tried.map(normal)).toEqual(chromeChannelCandidates(host))
    expect(tried.length).toBeGreaterThan(0)
  }
})

it('rejects malformed endpoints before mounting any browser resources', () => {
  expect(() => { Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://localhost:bad/path' })) }).toThrow('browser endpoint')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('replaces only Playwright\'s missing-browser failure with the final setup message', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', browserAdditions: true }))
  const explain = vi.mocked(mountSessionMcp).mock.calls[0]![1].explainFailure!
  for (const message of [
    'Browser "chromium" is not installed; expected executable at /home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome. Run `npx @playwright/mcp install-browser chromium` to install',
    'browserType.launch: Executable doesn\'t exist at /home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  ]) {
    expect(explain(message)).toBe(Provider.MISSING_BROWSER_MESSAGE)
  }
  for (const message of [
    // As Playwright's server sends a failure: a `### Error` header line, then the message, with or without `Error: `.
    '### Error\nError: Browser "chromium" is not installed; expected executable at /cache/chromium-1243/chrome. Run `npx @playwright/mcp install-browser chromium` to install',
    '### Error\nBrowser "chromium" is not installed. Run `npx @playwright/mcp install-browser chromium` to install',
    '### Error\nError: browserType.launch: Executable doesn\'t exist at /cache/chromium-1243/chrome-linux64/chrome\n╔═ Looks like Playwright was just installed ═╗',
    'Browser "chromium" is not installed. Run `npx @playwright/mcp install-browser chromium` to install',
    'Error: Browser "chromium" is not installed; expected executable at /cache/chromium-1243/chrome. Run `npx @playwright/mcp install-browser chromium` to install',
    'Executable doesn\'t exist at /cache/chromium-1243/chrome-linux64/chrome\n╔═ Looks like Playwright was just installed ═╗',
  ]) {
    expect(explain(message)).toBe(Provider.MISSING_BROWSER_MESSAGE)
  }
  for (const message of [
    '### Error\nError: browserType.launch: Chromium distribution \'chrome\' is not found at /opt/google/chrome/chrome\nRun "npx playwright install chrome"',
    'Chromium distribution \'chrome\' is not found at /opt/google/chrome/chrome',
  ]) {
    expect(explain(message)).toBe(Provider.MISSING_CHROME_MESSAGE)
  }
  expect(Provider.MISSING_CHROME_MESSAGE).toContain('finish Browser setup in Plugins')
  for (const message of [
    'page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.invalid/',
    'page.evaluate: Error: the page says Executable doesn\'t exist at /usr/bin/tool',
    'expect(locator).toHaveText failed: received "Browser "chromium" is not installed; expected executable at /x. Run `npx @playwright/mcp install-browser chromium` to install"',
    'The plugin is not installed; expected executable at /usr/bin/plugin',
    '### Error\nError: page.evaluate: the page says Chromium distribution \'chrome\' is not found',
    '### Result\n### Error\nBrowser "chromium" is not installed. Run `npx @playwright/mcp install-browser chromium` to install',
    'Chromium distribution \'msedge\' is not found at /opt/microsoft/msedge/msedge',
    'Browser "chromium" is not installed; expected executable at /x',
  ]) {
    expect(explain(message)).toBeUndefined()
  }
  expect(Provider.MISSING_BROWSER_MESSAGE).toContain('finish Browser setup in Plugins')
})

it('runs the server in one folder of the Harness home for every Session when serverDirectory is home', () => {
  vi.stubEnv('DSH_HOME', '/home/person/.delorun')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', serverDirectory: 'home' }))
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', serverDirectory: 'session' }))
  Provider.apply(new Context(), Provider.Config({ mode: 'launch' }))
  const directories = vi.mocked(mountSessionMcp).mock.calls.map(([, options]) => options.directory)
  expect(directories).toEqual(['/home/person/.delorun/browser-use/playwright-mcp', undefined, undefined])
  expect(() => Provider.Config({ mode: 'launch', serverDirectory: 'workspace' } as never)).toThrow()
})

it('refuses a file argument that a link inside the chat\'s folder leads outside, for saved files and for uploads', async () => {
  const { chat, outside } = await chatFolder()
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(outside, join(chat, 'link'))
  await symlink(join(outside, 'secret.txt'), join(chat, 'notes.txt'))
  await symlink(join(outside, 'not-yet.png'), join(chat, 'dangling.png'))
  const refuse = (args: unknown) => Provider.refuseOutsideFolder({ tool: 'browser_take_screenshot', arguments: args, directory: chat })
  await symlink(join(chat, 'loop-b'), join(chat, 'loop-a'))
  await symlink(join(chat, 'loop-a'), join(chat, 'loop-b'))
  for (const filename of ['link/shot.png', join(chat, 'link', 'shot.png'), 'link/new/deep/shot.png', 'notes.txt', 'dangling.png', '../link/shot.png', 'loop-a/shot.png']) {
    expect(await refuse({ filename })).toBe(Provider.outsideFolderMessage(filename))
  }
  expect(await refuse({ paths: [join(chat, 'ok.txt'), join(chat, 'link', 'secret.txt')] })).toBe(Provider.outsideFolderMessage(join(chat, 'link', 'secret.txt')))
  expect(await refuse({ filename: join(outside, 'shot.png') })).toBe(Provider.outsideFolderMessage(join(outside, 'shot.png')))
  expect(await refuse({ filename: '../outside/shot.png' })).toContain('leads outside it')
  expect(existsSync(join(outside, 'shot.png'))).toBe(false)
})

it('refuses every call, with or without a file argument, while the output folder is a link that leads outside the chat\'s folder', async () => {
  const { chat, outside } = await chatFolder()
  const refuse = (tool: string, args: unknown) => Provider.refuseOutsideFolder({ tool, arguments: args, directory: chat })
  const calls: [string, unknown][] = [
    ['browser_navigate', { url: 'https://example.com/download' }], ['browser_take_screenshot', {}], ['browser_click', { ref: 'e1' }],
    ['browser_pdf_save', { filename: 'page.pdf' }], ['browser_snapshot', undefined],
  ]
  for (const [tool, args] of calls) expect(await refuse(tool, args)).toBeUndefined()
  await symlink(outside, join(chat, Provider.OUTPUT_FOLDER))
  for (const [tool, args] of calls) expect(await refuse(tool, args)).toBe(Provider.LINKED_OUTPUT_FOLDER_MESSAGE)
  await rm(join(chat, Provider.OUTPUT_FOLDER))
  await symlink(join(outside, 'not-there-yet'), join(chat, Provider.OUTPUT_FOLDER))
  for (const [tool, args] of calls) expect(await refuse(tool, args)).toBe(Provider.LINKED_OUTPUT_FOLDER_MESSAGE)
  expect(await readdir(outside)).toEqual([])
  expect(Provider.LINKED_OUTPUT_FOLDER_MESSAGE).toContain('tell the person to remove or replace ".playwright-mcp"')
})

it('lets calls through when the output folder is a real folder or a link that stays inside the chat\'s folder', async () => {
  const { chat } = await chatFolder()
  await mkdir(join(chat, 'shots'))
  await symlink(join(chat, 'shots'), join(chat, Provider.OUTPUT_FOLDER))
  const refuse = (args: unknown) => Provider.refuseOutsideFolder({ tool: 'browser_take_screenshot', arguments: args, directory: chat })
  expect(await refuse({})).toBeUndefined()
  expect(await refuse({ filename: 'shot.png' })).toBeUndefined()
})

it('lets through file arguments that stay inside the chat\'s folder, and calls without file arguments', async () => {
  const { chat } = await chatFolder()
  await mkdir(join(chat, 'real'))
  await symlink(join(chat, 'real'), join(chat, 'inside-link'))
  await writeFile(join(chat, 'real', 'upload.txt'), 'upload')
  const refuse = (args: unknown) => Provider.refuseOutsideFolder({ tool: 'browser_file_upload', arguments: args, directory: chat })
  for (const args of [
    { filename: 'shot.png' }, { filename: 'new/deep/shot.png' }, { filename: 'real/upload.txt/under-a-file.png' }, { filename: join(chat, 'real', 'shot.png') }, { filename: 'inside-link/shot.png' },
    { paths: [join(chat, 'real', 'upload.txt'), join(chat, 'inside-link', 'upload.txt')] },
    { url: 'https://example.com' }, { filename: 7, paths: 'not-a-list' }, { paths: [7] }, {}, null, 'text', undefined,
  ]) {
    expect(await refuse(args)).toBeUndefined()
  }
})

it('catches a file the server wrote through a nested link, removes it without following links, and refuses the call', async () => {
  const { chat, outside } = await chatFolder()
  const output = join(chat, Provider.OUTPUT_FOLDER)
  await mkdir(join(output, 'sub'), { recursive: true })
  await writeFile(join(outside, 'older.txt'), 'the person\'s own file')
  await new Promise(done => setTimeout(done, 1100))
  await symlink(outside, join(output, 'sub', 'out'))
  const lines: string[] = []
  const check = (args: unknown, startedAt: number) =>
    Provider.refuseWrittenOutside({ tool: 'browser_take_screenshot', arguments: args, directory: chat }, startedAt, line => lines.push(line))
  const before = Date.now()
  expect(await check({}, before)).toBeUndefined()
  await writeFile(join(outside, 'download.pdf'), 'landed')
  expect(await check({}, before)).toBe(Provider.writtenOutsideMessage(true))
  expect(existsSync(join(outside, 'download.pdf'))).toBe(false)
  expect(readFileSync(join(outside, 'older.txt'), 'utf8')).toBe('the person\'s own file')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('outside the chat')
  // The link itself stays: removal never follows or changes it.
  expect(await realpath(join(output, 'sub', 'out'))).toBe(outside)
})

it('catches a file written to a filename that leads outside, and leaves a file the call did not create', async () => {
  const { chat, outside } = await chatFolder()
  await mkdir(join(chat, Provider.OUTPUT_FOLDER))
  await symlink(outside, join(chat, Provider.OUTPUT_FOLDER, 'out'))
  const check = (filename: string, startedAt: number) =>
    Provider.refuseWrittenOutside({ tool: 'browser_pdf_save', arguments: { filename }, directory: chat }, startedAt, () => {})
  await writeFile(join(outside, 'old.pdf'), 'old')
  expect(await check('out/old.pdf', Date.now() + 60_000)).toBeUndefined()
  expect(existsSync(join(outside, 'old.pdf'))).toBe(true)
  const startedAt = Date.now()
  await writeFile(join(outside, 'new.pdf'), 'new')
  expect(await check('out/new.pdf', startedAt)).toBe(Provider.writtenOutsideMessage(true))
  expect(existsSync(join(outside, 'new.pdf'))).toBe(false)
})

it('reports a file it cannot remove, and accepts a screenshot and a download that stay inside the folder', async () => {
  const { chat, outside } = await chatFolder()
  await mkdir(join(chat, Provider.OUTPUT_FOLDER))
  const check = (args: unknown, startedAt: number) =>
    Provider.refuseWrittenOutside({ tool: 'browser_take_screenshot', arguments: args, directory: chat }, startedAt, () => {})
  const startedAt = Date.now()
  await writeFile(join(chat, Provider.OUTPUT_FOLDER, 'page.png'), 'png')
  await writeFile(join(chat, 'download.zip'), 'zip')
  expect(await check({ filename: 'page.png' }, startedAt)).toBeUndefined()
  expect(await check({ filename: 'download.zip' }, startedAt)).toBeUndefined()
  await symlink(outside, join(chat, Provider.OUTPUT_FOLDER, 'out'))
  await mkdir(join(outside, 'folder-made-by-call'))
  expect(await check({}, startedAt)).toBeUndefined()
  await symlink(join(outside, 'elsewhere'), join(outside, 'link-made-by-call'))
  expect(await check({}, startedAt)).toBeUndefined()
  expect(existsSync(join(chat, Provider.OUTPUT_FOLDER, 'page.png'))).toBe(true)
  expect(existsSync(join(chat, 'download.zip'))).toBe(true)
})

it('gives mountSessionMcp the read copy and the after-call check', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch' }))
  expect(vi.mocked(mountSessionMcp).mock.calls.at(-1)![1].checkResult).toBeTypeOf('function')
  expect(vi.mocked(mountSessionMcp).mock.calls.at(-1)![1].prepareCall).toBe(Provider.copyReadArguments)
})

it('puts the output folders in the per-user cache folder, outside the chat\'s folder and the Delorun home', () => {
  expect(Provider.outputRoot('linux', { XDG_CACHE_HOME: '/cache' }, '/home/p')).toBe('/cache/delorun-browser-output')
  expect(Provider.outputRoot('linux', { XDG_CACHE_HOME: 'relative' }, '/home/p')).toBe('/home/p/.cache/delorun-browser-output')
  expect(Provider.outputRoot('linux', {}, '/home/p')).toBe('/home/p/.cache/delorun-browser-output')
  expect(Provider.outputRoot('darwin', {}, '/Users/p')).toBe('/Users/p/Library/Caches/delorun-browser-output')
  expect(Provider.outputRoot('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\p')).toContain('delorun-browser-output')
  expect(Provider.outputRoot('win32', {}, '/home/p')).toContain('AppData')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch' }))
  const root = vi.mocked(mountSessionMcp).mock.calls.at(-1)![1].outputRoot!
  expect(root).toBe(Provider.outputRoot(process.platform, process.env, homedir()))
})

it('with an output folder, writes only inside it: a path into the chat\'s folder or elsewhere is refused before the call', async () => {
  const { chat, outside } = await chatFolder()
  const outputDirectory = join(outside, 'cache')
  await mkdir(outputDirectory)
  await symlink(outside, join(chat, 'link'))
  const refuse = (filename: string, tool = 'browser_take_screenshot') =>
    Provider.refuseOutsideFolder({ tool, arguments: { filename }, directory: chat, outputDirectory })
  expect(await refuse('page.png')).toBeUndefined()
  expect(await refuse(join(outputDirectory, 'page.png'))).toBeUndefined()
  expect(await refuse('sub/page.png')).toBeUndefined()
  for (const filename of [join(chat, 'page.png'), join(chat, 'link', 'x.png'), join(outside, 'page.png'), '../../escape.png']) {
    expect(await refuse(filename)).toBe(Provider.writeOutsideOutputMessage(outputDirectory))
  }
  expect(Provider.writeOutsideOutputMessage(outputDirectory)).toContain(`Browser saves to its own folder: ${outputDirectory}`)
  // A tool that reads its filename is not a write.
  expect(await refuse(join(chat, 'state.json'), 'browser_set_storage_state')).toBeUndefined()
})

it('copies a file the server would read from the chat\'s folder into the output folder, and the server never gets the chat\'s path', async () => {
  const { chat, outside } = await chatFolder()
  const outputDirectory = join(outside, 'cache')
  await mkdir(outputDirectory)
  await writeFile(join(chat, 'photo.png'), 'photo')
  await writeFile(join(outputDirectory, 'earlier.png'), 'earlier')
  const prepare = (tool: string, args: unknown) => Provider.copyReadArguments({ tool, arguments: args, directory: chat, outputDirectory })
  const prepared = await prepare('browser_file_upload', { paths: ['photo.png', join(chat, 'photo.png'), join(outputDirectory, 'earlier.png')] })
  const paths = (prepared as { arguments: { paths: string[] } }).arguments.paths
  expect(paths).toHaveLength(3)
  for (const copy of paths.slice(0, 2)) {
    expect(copy.startsWith(outputDirectory)).toBe(true)
    expect(readFileSync(copy, 'utf8')).toBe('photo')
    expect(statSync(copy).mode & 0o777).toBe(0o600)
  }
  expect(paths[0]).not.toBe(paths[1])
  expect(paths[2]).toBe(join(outputDirectory, 'earlier.png'))
  // A link swapped in after the copy changes nothing the server reads.
  await rm(join(chat, 'photo.png'))
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(chat, 'photo.png'))
  expect(readFileSync(paths[0]!, 'utf8')).toBe('photo')
  const state = await prepare('browser_set_storage_state', { filename: 'state.json' })
  expect(state).toBe(Provider.unreadableMessage('state.json'))
  expect(await prepare('browser_navigate', { url: 'https://example.com' })).toBeUndefined()
  expect(await prepare('browser_take_screenshot', { filename: 'x.png' })).toBeUndefined()
})

it('refuses a read through a link that leads outside the chat\'s folder, a missing file, a folder, and reads nothing outside', async () => {
  const { chat, outside } = await chatFolder()
  const outputDirectory = join(outside, 'cache')
  await mkdir(outputDirectory)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(chat, 'notes.txt'))
  await symlink(outside, join(chat, 'link'))
  await mkdir(join(chat, 'folder'))
  for (const name of ['notes.txt', 'link/secret.txt', join(outside, 'secret.txt'), 'missing.txt', 'folder', '../outside/secret.txt']) {
    const prepared = await Provider.copyReadArguments({ tool: 'browser_file_upload', arguments: { paths: [name] }, directory: chat, outputDirectory })
    expect(prepared).toBe(Provider.unreadableMessage(name))
  }
  expect(await readdir(outputDirectory)).toEqual([])
})

it('with an output folder, still catches a file that landed through a link inside it', async () => {
  const { chat, outside } = await chatFolder()
  const outputDirectory = join(outside, 'cache')
  const elsewhere = join(outside, 'elsewhere')
  await Promise.all([mkdir(outputDirectory), mkdir(elsewhere)])
  await symlink(elsewhere, join(outputDirectory, 'out'))
  const startedAt = Date.now()
  await writeFile(join(outputDirectory, 'fine.png'), 'png')
  await writeFile(join(elsewhere, 'landed.pdf'), 'pdf')
  const lines: string[] = []
  const call = { tool: 'browser_pdf_save', arguments: { filename: 'out/landed.pdf' }, directory: chat, outputDirectory }
  expect(await Provider.refuseWrittenOutside(call, startedAt, line => lines.push(line))).toBe(Provider.writtenOutsideMessage(true))
  expect(existsSync(join(elsewhere, 'landed.pdf'))).toBe(false)
  expect(existsSync(join(outputDirectory, 'fine.png'))).toBe(true)
  expect(lines).toHaveLength(1)
})

it('keeps the tool denial, the folder guard and the MCP root with browser_additions off', async () => {
  // C16's parity composition turns browser_additions off; the denial and the guard are security invariants that hold
  // with every switch off. The runtime tells the Session's folder as the one MCP root whatever options the provider
  // passes (browser-use-runtime's mcp.spec), so the guard checks the folder the server resolves against.
  const { chat, outside } = await chatFolder()
  for (const config of [{ mode: 'launch' }, { mode: 'attach', endpoint: 'http://127.0.0.1:9222' }, { mode: 'launch', browserAdditions: false }] as const) {
    expect(Provider.Config(config).browserAdditions).toBe(false)
    Provider.apply(new Context(), Provider.Config(config))
    const options = vi.mocked(mountSessionMcp).mock.calls.at(-1)![1]
    expect(options.explainFailure).toBeUndefined()
    expect(options.outputFolder).toBeUndefined()
    expect(options.deniedTools).toEqual(['browser_run_code_unsafe'])
    expect(await options.refuseCall!({ tool: 'browser_run_code_unsafe', arguments: { code: 'async page => 1' }, directory: chat }))
      .toBe(Provider.deniedToolMessage('browser_run_code_unsafe'))
    expect(await options.refuseCall!({ tool: 'browser_take_screenshot', arguments: { filename: join(outside, 'shot.png') }, directory: chat }))
      .toBe(Provider.outsideFolderMessage(join(outside, 'shot.png')))
    expect(await options.refuseCall!({ tool: 'browser_take_screenshot', arguments: { filename: 'shot.png' }, directory: chat })).toBeUndefined()
  }
  for (const config of [{ mode: 'launch', browserAdditions: true }, { mode: 'attach', endpoint: 'http://127.0.0.1:9222', browserAdditions: true }] as const) {
    Provider.apply(new Context(), Provider.Config(config))
    const options = vi.mocked(mountSessionMcp).mock.calls.at(-1)![1]
    expect(options).toMatchObject({ explainFailure: Provider.explainMissingBrowser, deniedTools: ['browser_run_code_unsafe'] })
    expect(options.outputFolder).toBeUndefined()
    expect(await options.refuseCall!({ tool: 'browser_take_screenshot', arguments: { filename: join(outside, 'shot.png') }, directory: chat }))
      .toBe(Provider.outsideFolderMessage(join(outside, 'shot.png')))
  }
})

it('turns off the tool that runs code in the server process: never registered, and refused when called', async () => {
  const { chat } = await chatFolder()
  for (const config of [{ mode: 'launch' }, { mode: 'attach', endpoint: 'http://127.0.0.1:9222' }] as const) {
    expect(Provider.Config(config).deniedTools).toEqual([])
    Provider.apply(new Context(), Provider.Config(config))
    const options = vi.mocked(mountSessionMcp).mock.calls.at(-1)![1]
    expect(options.deniedTools).toEqual(['browser_run_code_unsafe'])
    for (const args of [{ code: 'async page => require("node:fs").writeFileSync("/tmp/x", "x")' }, { filename: 'code.js' }, {}, undefined]) {
      expect(await options.refuseCall!({ tool: 'browser_run_code_unsafe', arguments: args, directory: chat }))
        .toBe(Provider.deniedToolMessage('browser_run_code_unsafe'))
    }
    expect(await options.refuseCall!({ tool: 'browser_evaluate', arguments: { function: '() => document.title' }, directory: chat })).toBeUndefined()
  }
  expect(Provider.deniedToolMessage('browser_run_code_unsafe')).toContain('is turned off here because it runs code outside the page')
})

it('keeps the server-code tool off whatever the configuration lists: an empty or other list cannot turn it back on', async () => {
  const { chat } = await chatFolder()
  for (const deniedTools of [[], ['browser_evaluate'], ['browser_run_code_unsafe', 'browser_run_code_unsafe']]) {
    for (const config of [{ mode: 'launch', deniedTools }, { mode: 'attach', endpoint: 'http://127.0.0.1:9222', deniedTools }] as const) {
      Provider.apply(new Context(), Provider.Config(config))
      const options = vi.mocked(mountSessionMcp).mock.calls.at(-1)![1]
      expect(options.deniedTools).toContain('browser_run_code_unsafe')
      expect(options.deniedTools!.filter(name => name === 'browser_run_code_unsafe')).toHaveLength(1)
      expect(await options.refuseCall!({ tool: 'browser_run_code_unsafe', arguments: { code: 'async page => 1' }, directory: chat }))
        .toBe(Provider.deniedToolMessage('browser_run_code_unsafe'))
    }
  }
  expect(Provider.deniedToolsOf({ deniedTools: [] })).toEqual(['browser_run_code_unsafe'])
})

it('turns off the configured tools as well, keeps the folder guard for the rest, and rejects a name that is not a tool name', async () => {
  const { chat, outside } = await chatFolder()
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', deniedTools: ['browser_evaluate', 'browser_file_upload'] }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options.deniedTools).toEqual(['browser_run_code_unsafe', 'browser_evaluate', 'browser_file_upload'])
  expect(await options.refuseCall!({ tool: 'browser_evaluate', arguments: {}, directory: chat })).toBe(Provider.deniedToolMessage('browser_evaluate'))
  expect(await options.refuseCall!({ tool: 'browser_click', arguments: { ref: 'e1' }, directory: chat })).toBeUndefined()
  expect(await options.refuseCall!({ tool: 'browser_take_screenshot', arguments: { filename: join(outside, 'shot.png') }, directory: chat }))
    .toBe(Provider.outsideFolderMessage(join(outside, 'shot.png')))
  expect(() => Provider.Config({ mode: 'launch', deniedTools: ['mcp__playwright-mcp__browser evaluate'] })).toThrow()
})

it('offers no other tool that runs model-written code in the server process in the pinned Playwright', () => {
  const require = createRequire(import.meta.url)
  const mcp = createRequire(require.resolve('@playwright/mcp/package.json'))
  const bundle = readFileSync(mcp.resolve('playwright-core/lib/coreBundle'), 'utf8')
  // Every tool file that evaluates code in the server's own process uses Node's `vm`; the page-side tools do not.
  // The comment marks Playwright's own source tree inside its bundle; it is not a path in this repository.
  const marker = `// ${['packages', 'playwright-core', 'src', 'tools', 'backend'].join('/')}/`
  const files = bundle.slice(bundle.indexOf(marker), bundle.indexOf(`${marker}tools.ts`)).split(marker).slice(1)
  const withVm = files.filter(file => /require\("(?:node:)?vm"\)/u.test(file))
  expect(files.length).toBeGreaterThan(20)
  expect(withVm.map(file => file.slice(0, file.indexOf('\n')))).toEqual(['runCode.ts'])
  const tools = withVm.flatMap(file => [...file.matchAll(/name: "(browser_[a-z_]+)"/gu)].map(match => match[1]))
  expect(tools).toEqual([...Provider.SERVER_CODE_TOOLS])
})

it('serves every Session while no browser admission is provided, asks a provided one at each ask, and hears its change reports', async () => {
  const ctx = new Context()
  Provider.apply(ctx, Provider.Config({ mode: 'launch' }))
  const admission = vi.mocked(mountSessionMcp).mock.calls.at(-1)![1].admission!
  const agent = { session: { header: { cwd: '/home/person/src/quiet' } } } as Parameters<typeof admission.admitted>[0]
  // The mount subscribes before any provider exists, as when the provider's plugin loads later.
  const heard = vi.fn(async (_session: unknown) => {})
  admission.changed(heard)
  expect(admission.admitted(agent)).toBe(true)
  const asked = vi.fn((_agent: unknown) => false)
  ctx.provide('browserUseAdmission', { admitted: asked })
  // The denial: once a provider says no, the mount is told no for that Session.
  expect(admission.admitted(agent)).toBe(false)
  expect(asked).toHaveBeenCalledWith(agent)
  await ctx.parallel('browser-use/admission-changed', agent.session)
  expect(heard.mock.calls).toEqual([[agent.session]])
})
