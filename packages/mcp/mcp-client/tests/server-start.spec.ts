/**
 * The Windows resolution of a stdio start, run against a fake host on any operating system: `PATH` and `PATHEXT`
 * lookup without searching the working directory first, commands with a separator resolved against the canonical
 * working directory, batch shims (`npx.cmd`) resolved to the file `cmd.exe` runs with the canonical `COMSPEC` that runs
 * it, and a closed failure for every start
 * the spawn would run differently.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServerStartUnresolvedError, resolveServerStart } from '@deepseek-ai/dsh-mcp-client'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import type { ServerStartHost } from '../src/server-start.ts'
import { nodeStartHost, windowsEnvValue } from '../src/server-start.ts'

afterEach(() => { vi.unstubAllEnvs() })

const COMSPEC = 'C:\\Windows\\System32\\cmd.exe'

/**
 * A Windows host over a set of files and directories, compared without case as NTFS compares them.
 * @param files - absolute file paths, each with the text its first bytes hold; `COMSPEC`'s `cmd.exe` is always present.
 * @param directories - absolute directory paths; the working directory and each file's parents are added.
 * @param options - the Host's working directory and environment, and links from one directory to another.
 * @returns the host.
 */
function windowsHost(
  files: Record<string, string>,
  directories: readonly string[] = [],
  options: { cwd?: string; env?: Record<string, string | undefined>; links?: Record<string, string> } = {},
): ServerStartHost {
  const key = (path: string): string => win32.normalize(path).toLowerCase()
  const cwd = options.cwd ?? 'C:\\work\\repo'
  const fileHeads = new Map(Object.entries({ [COMSPEC]: 'MZ', ...files }).map(([path, head]) => [key(path), head]))
  const dirs = new Set([cwd, ...directories].map(key))
  for (const path of Object.keys(files)) {
    for (let parent = win32.dirname(path); parent !== win32.dirname(parent); parent = win32.dirname(parent)) dirs.add(key(parent))
  }
  const links = new Map(Object.entries(options.links ?? {}).map(([from, to]) => [key(from), to]))
  return {
    platform: 'win32',
    cwd,
    env: options.env ?? { ComSpec: COMSPEC },
    realpath: async (path) => {
      const target = links.get(key(path)) ?? win32.normalize(path)
      if (!links.has(key(path)) && !dirs.has(key(target)) && !fileHeads.has(key(target))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return target
    },
    kind: async (path) => {
      if (fileHeads.has(key(path))) return { file: true, directory: false }
      if (dirs.has(key(path))) return { file: false, directory: true }
      return undefined
    },
    executable: async () => true,
    head: async path => fileHeads.get(key(path)) ?? '',
  }
}

/** A stdio config with the given command, cwd and env. */
function start(command: string, extra: Partial<Pick<Config & { transport: 'stdio' }, 'cwd' | 'env'>> = {}): Config & { transport: 'stdio' } {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command,
    args: ['-y', '@scope/server'],
    env: extra.env ?? {},
    cwd: extra.cwd ?? '',
    toolCallTimeoutMs: 1000,
    failOnStartupError: false,
  }
}

/** The refusal reason of a start that does not resolve. */
async function refusal(config: Config & { transport: 'stdio' }, host: ServerStartHost): Promise<string> {
  const error: unknown = await resolveServerStart(config, host).catch((failure: unknown) => failure)
  if (!(error instanceof McpServerStartUnresolvedError)) throw new Error(`expected an unresolved start, got ${String(error)}`)
  expect(error.message).toContain(JSON.stringify(config.command))
  return error.reason
}

const NODE_DIR = 'C:\\Program Files\\nodejs'

describe('resolving a stdio start on Windows', () => {
  it('finds a bare command through PATH and PATHEXT, resolving npx to the npx.cmd shim cmd.exe runs', async () => {
    const host = windowsHost({ [`${NODE_DIR}\\npx.cmd`]: '@ECHO off\r\n', [`${NODE_DIR}\\node.exe`]: 'MZ' })
    const env = { PATH: `C:\\Windows;"${NODE_DIR}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    await expect(resolveServerStart(start('npx', { env }), host)).resolves.toMatchObject({
      resolvedCommand: `${NODE_DIR}\\npx.cmd`,
      resolvedCwd: 'C:\\work\\repo',
    })
    await expect(resolveServerStart(start('node', { env }), host)).resolves.toMatchObject({ resolvedCommand: `${NODE_DIR}\\node.exe` })
  })

  it('shows the review the canonical COMSPEC that runs a batch shim, and no shell for a file run directly', async () => {
    const files = { [`${NODE_DIR}\\npx.cmd`]: '@ECHO off\r\n', [`${NODE_DIR}\\node.exe`]: 'MZ', 'D:\\shells\\cmd.exe': 'MZ' }
    const env = { PATH: NODE_DIR }
    expect(await resolveServerStart(start('npx', { env }), windowsHost(files))).toMatchObject({ resolvedCommand: `${NODE_DIR}\\npx.cmd`, resolvedShell: COMSPEC })
    const linked = windowsHost(files, [], { links: { [COMSPEC]: 'D:\\shells\\cmd.exe' } })
    expect((await resolveServerStart(start('npx', { env }), linked)).resolvedShell).toBe('D:\\shells\\cmd.exe')
    expect(await resolveServerStart(start('node', { env }), linked)).not.toHaveProperty('resolvedShell')
  })

  it('compares PATHEXT extensions without case, in PATHEXT order, and tries a name with an extension as written first', async () => {
    const host = windowsHost({ 'C:\\tools\\uvx.EXE': 'MZ', 'C:\\tools\\uvx.bat': '@echo off', 'C:\\tools\\run.cmd': '@echo off' })
    expect((await resolveServerStart(start('uvx', { env: { PATH: 'C:\\tools', PATHEXT: '.bat;.exe' } }), host)).resolvedCommand).toBe('C:\\tools\\uvx.bat')
    expect((await resolveServerStart(start('uvx', { env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.BAT' } }), host)).resolvedCommand).toBe('C:\\tools\\uvx.exe')
    expect((await resolveServerStart(start('RUN.CMD', { env: { PATH: 'C:\\tools' } }), host)).resolvedCommand).toBe('C:\\tools\\RUN.CMD')
  })

  it('does not pick a file in the working directory, or in an empty or relative PATH entry, by its name alone', async () => {
    const host = windowsHost({ 'C:\\work\\repo\\npx.cmd': '@echo planted', 'C:\\work\\repo\\bin\\npx.cmd': '@echo planted', [`${NODE_DIR}\\npx.cmd`]: '@echo off' })
    const env = { PATH: `;.;bin;${NODE_DIR}` }
    expect((await resolveServerStart(start('npx', { env }), host)).resolvedCommand).toBe(`${NODE_DIR}\\npx.cmd`)
    expect(await refusal(start('npx', { env: { PATH: ';.;bin' } }), host)).toBe('no file named "npx" with an extension PATHEXT lists is in an absolute entry of the server\'s PATH')
  })

  it('reads PATH as Node passes it: names without case, the first spelling in sorted order', () => {
    expect(windowsEnvValue({ Path: 'C:\\second', PATH: 'C:\\first' }, 'path')).toBe('C:\\first')
    expect(windowsEnvValue({ pathext: '.EXE' }, 'PATHEXT')).toBe('.EXE')
    expect(windowsEnvValue({}, 'PATH')).toBeUndefined()
  })

  it('resolves a command with a separator against the canonical working directory', async () => {
    const host = windowsHost({ 'D:\\real\\repo\\scripts\\serve.cmd': '@echo off' }, [], { links: { 'C:\\work\\repo': 'D:\\real\\repo' } })
    const resolved = await resolveServerStart(start('scripts\\serve', { env: { PATH: 'C:\\Windows' } }), host)
    expect(resolved).toMatchObject({ resolvedCwd: 'D:\\real\\repo', resolvedCommand: 'D:\\real\\repo\\scripts\\serve.cmd' })
    expect((await resolveServerStart(start('./scripts/serve.cmd', { env: { PATH: 'C:\\Windows' } }), host)).resolvedCommand).toBe('D:\\real\\repo\\scripts\\serve.cmd')
    expect((await resolveServerStart(start('D:\\real\\repo\\scripts\\serve.cmd'), host)).resolvedCommand).toBe('D:\\real\\repo\\scripts\\serve.cmd')
  })

  it('resolves a relative working directory against the Host\'s', async () => {
    const host = windowsHost({ 'C:\\work\\repo\\server\\run.exe': 'MZ' })
    const resolved = await resolveServerStart(start('.\\run.exe', { cwd: 'server' }), host)
    expect(resolved).toMatchObject({ resolvedCwd: 'C:\\work\\repo\\server', resolvedCommand: 'C:\\work\\repo\\server\\run.exe' })
  })

  it('keeps a start stopped that the Windows spawn would run differently, naming the command', async () => {
    const files = {
      'C:\\tools\\script.js': 'console.log(1)',
      'C:\\tools\\shebang.cmd': '#!/usr/bin/env node\n',
      'C:\\tools\\shim.cmd': '@echo off',
    }
    const host = windowsHost(files)
    expect(await refusal(start('script', { env: { PATH: 'C:\\tools', PATHEXT: '.JS;.EXE' } }), host))
      .toBe('"C:\\\\tools\\\\script.js" would start through the program its extension is associated with')
    expect(await refusal(start('shebang', { env: { PATH: 'C:\\tools' } }), host))
      .toBe('"C:\\\\tools\\\\shebang.cmd" starts with a #! line, whose interpreter the Windows spawn looks up itself')
    for (const env of [{}, { ComSpec: 'cmd.exe' }, { ComSpec: 'C:\\missing\\cmd.exe' }, { ComSpec: 'C:\\tools' }]) {
      expect(await refusal(start('shim', { env: { PATH: 'C:\\tools' } }), windowsHost(files, [], { env })))
        .toBe('"C:\\\\tools\\\\shim.cmd" runs through COMSPEC, which is not set to an existing absolute file')
    }
    expect((await resolveServerStart(start('shim', { env: { PATH: 'C:\\tools' } }), host)).resolvedCommand).toBe('C:\\tools\\shim.cmd')
    expect(await refusal(start('missing', { env: { PATH: 'C:\\tools' } }), host))
      .toBe('no file named "missing" with an extension PATHEXT lists is in an absolute entry of the server\'s PATH')
    expect(await refusal(start('.\\absent'), host)).toBe('"C:\\\\work\\\\repo\\\\absent" is not a file whose extension PATHEXT lists')
    expect(await refusal(start('C:\\tools'), host)).toBe('"C:\\\\tools" is not a file whose extension PATHEXT lists')
  })

  it('keeps a start stopped when the server\'s environment sets no PATH', async () => {
    const host = windowsHost({ 'C:\\tools\\x.exe': 'MZ' })
    vi.stubEnv('PATH', undefined)
    vi.stubEnv('Path', undefined)
    expect(await refusal(start('x'), host)).toBe('the server\'s environment sets no PATH to look the command up in')
  })
})

describe('the Node host', () => {
  it('reads a file\'s first bytes for its #! line, and nothing from a file it cannot read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-head-'))
    try {
      writeFileSync(join(dir, 'script'), `#!/usr/bin/env node\n${'x'.repeat(400)}`)
      const head = await nodeStartHost.head(join(dir, 'script'))
      expect(head.startsWith('#!/usr/bin/env node')).toBe(true)
      expect(head).toHaveLength(150)
      await expect(nodeStartHost.head(join(dir, 'absent'))).resolves.toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
