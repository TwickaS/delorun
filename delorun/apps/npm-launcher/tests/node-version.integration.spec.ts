/**
 * The launcher's Node requirement: an older Node gets one plain line and exit status 1 before the launcher's main
 * module is loaded, and the published package declares the same range.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLauncher } from '../src/build.ts'
import { fixtureRelease } from '../../install/tests/support.ts'
import { loopRefusal, PNP_RERUN_ENV } from '../src/pnp.ts'
import { MINIMUM_NODE, NODE_ENGINES_RANGE, nodeIsSupported, nodeRefusal } from '../src/node-version.ts'

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../src/bin.ts')
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('the Node versions the launcher runs on', () => {
  it('accepts the minimum and every newer version, and refuses every older one', () => {
    expect(nodeIsSupported('24.9.0')).toBe(true)
    expect(nodeIsSupported('24.9.1')).toBe(true)
    expect(nodeIsSupported('24.22.0')).toBe(true)
    expect(nodeIsSupported('26.0.0')).toBe(true)
    expect(nodeIsSupported('24.8.9')).toBe(false)
    expect(nodeIsSupported('22.20.0')).toBe(false)
    expect(nodeIsSupported('18.0.0')).toBe(false)
    expect(nodeIsSupported('24.9')).toBe(true)
    expect(nodeIsSupported('24')).toBe(false)
  })

  it('states the range the way the published package declares it, and the repository requires no older Node', async () => {
    expect(NODE_ENGINES_RANGE).toBe('>=24.9.0')
    const root = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', '..', '..', 'package.json'), 'utf8')) as { engines: { node: string } }
    expect(root.engines.node).toBe(NODE_ENGINES_RANGE)
    expect(MINIMUM_NODE).toEqual([24, 9, 0])
  })

  it('says in one line what Node it needs, what it found, and what to do', () => {
    const line = nodeRefusal('20.11.1')
    expect(line).toBe('Delorun needs Node 24.9 or newer to start, and this is Node 20.11.1. Install a newer Node from https://nodejs.org, then run the same command again.')
    expect(line).not.toContain('\n')
    expect(nodeRefusal(process.versions.node)).toBeUndefined()
  })
})

describe('the entry the package’s bin runs', () => {
  it('prints the refusal and exits 1 on an older Node, without loading the launcher', async () => {
    const main = vi.fn()
    vi.doMock('../src/bin.ts', () => ({ main }))
    vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, node: '20.11.1' })
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((text: string | Uint8Array) => { written.push(String(text)); return true })
    await import('../src/entry.ts')
    expect(written.join('')).toBe(`${nodeRefusal('20.11.1')}\n`)
    expect(process.exitCode).toBe(1)
    expect(main).not.toHaveBeenCalled()
  })

  it('runs the launcher with the arguments after the script and keeps its exit status', async () => {
    const main = vi.fn(() => Promise.resolve(3))
    vi.doMock('../src/bin.ts', () => ({ main }))
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'delorun', '--profile', 'work'])
    await import('../src/entry.ts')
    await vi.waitFor(() => expect(process.exitCode).toBe(3))
    expect(main).toHaveBeenCalledWith(['--profile', 'work'])
  })

  it('refuses on an older Node in the built package: one line, exit 1, nothing read or written', async () => {
    const work = await mkdtemp(join(tmpdir(), 'delorun-launcher-node-'))
    try {
      const fixture = await fixtureRelease()
      await writeFile(join(work, 'root.json'), fixture.roots[0]!)
      const built = await buildLauncher({ roots: [join(work, 'root.json')], out: join(work, 'out'), version: '0.0.1-node' })
      // The preload makes the built entry see an older Node, as `npx` on that Node would.
      await writeFile(join(work, 'old-node.cjs'), "Object.defineProperty(process.versions, 'node', { value: '20.11.1' })\n")
      const home = join(work, 'home')
      const finished = spawnSync(process.execPath, ['--require', join(work, 'old-node.cjs'), join(built.directory, 'dist', 'bin.js'), '--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', DELORUN_HOME: home }, timeout: 50_000 })
      expect(finished.status, `signal ${String(finished.signal)}: ${finished.stderr}`).toBe(1)
      expect(finished.stdout).toBe('')
      expect(finished.stderr).toBe(`${nodeRefusal('20.11.1')}\n`)
      await expect(readdir(home)).rejects.toMatchObject({ code: 'ENOENT' })
      // The entry is a file of its own: the launcher's main module is a chunk that the refusal never loads.
      const entry = await readFile(join(built.directory, 'dist', 'bin.js'), 'utf8')
      expect(entry.match(/^import .*$/gmu) ?? []).toEqual([])
      expect(entry).toMatch(/import\("\.\/bin-[^"]+\.js"\)/u)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 120_000)

  it('imports only the version check statically, so an older Node refuses before it reads anything newer', async () => {
    const entry = await readFile(join(import.meta.dirname, '..', 'src', 'entry.ts'), 'utf8')
    expect(entry.match(/^import .*$/gmu)).toEqual(["import { nodeRefusal } from './node-version.ts'"])
  })
})

describe('the entry under Yarn\'s Plug\'n\'Play', () => {
  it('leaves Plug\'n\'Play before it loads the launcher, and ends with the re-run\'s status', async () => {
    const main = vi.fn()
    const leavePnp = vi.fn(() => Promise.resolve({ action: 'exit' as const, code: 5 }))
    vi.doMock('../src/bin.ts', () => ({ main }))
    vi.doMock('../src/pnp.ts', () => ({ leavePnp, signalStatus: () => 1 }))
    const underPnp = { ...process.versions, node: process.versions.node, pnp: '3' } as NodeJS.ProcessVersions
    vi.spyOn(process, 'versions', 'get').mockReturnValue(underPnp)
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'delorun', '--help'])
    await import('../src/entry.ts')
    await vi.waitFor(() => expect(process.exitCode).toBe(5))
    expect(leavePnp).toHaveBeenCalledWith(expect.objectContaining({ pnp: '3', argv: ['--help'] }))
    expect(main).not.toHaveBeenCalled()
    vi.doUnmock('../src/pnp.ts')
  })

  it('prints the refusal and exits 1 when the re-run cannot happen, without loading the launcher', async () => {
    const main = vi.fn()
    vi.doMock('../src/bin.ts', () => ({ main }))
    vi.doMock('../src/pnp.ts', () => ({ leavePnp: () => Promise.resolve({ action: 'refuse', line: 'one line' }), signalStatus: () => 1 }))
    const underPnp = { ...process.versions, node: process.versions.node, pnp: '3' } as NodeJS.ProcessVersions
    vi.spyOn(process, 'versions', 'get').mockReturnValue(underPnp)
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((text: string | Uint8Array) => { written.push(String(text)); return true })
    await import('../src/entry.ts')
    await vi.waitFor(() => expect(process.exitCode).toBe(1))
    expect(written.join('')).toBe('one line\n')
    expect(main).not.toHaveBeenCalled()
    vi.doUnmock('../src/pnp.ts')
  })

  it('raises the signal that ended the re-run on itself, and keeps the signal\'s status as its exit code', async () => {
    vi.doMock('../src/bin.ts', () => ({ main: vi.fn() }))
    vi.doMock('../src/pnp.ts', () => ({ leavePnp: () => Promise.resolve({ action: 'signal', signal: 'SIGTERM' }), signalStatus: () => 143 }))
    const underPnp = { ...process.versions, node: process.versions.node, pnp: '3' } as NodeJS.ProcessVersions
    vi.spyOn(process, 'versions', 'get').mockReturnValue(underPnp)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    await import('../src/entry.ts')
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM'))
    expect(process.exitCode).toBe(143)
    vi.doUnmock('../src/pnp.ts')
  })

  it('says in one line that it could not leave Plug\'n\'Play, and exits 1, when the re-run cannot start', async () => {
    vi.doMock('../src/bin.ts', () => ({ main: vi.fn() }))
    vi.doMock('../src/pnp.ts', () => ({ leavePnp: () => Promise.reject(new Error('spawn ENOENT')), signalStatus: () => 1 }))
    const underPnp = { ...process.versions, node: process.versions.node, pnp: '3' } as NodeJS.ProcessVersions
    vi.spyOn(process, 'versions', 'get').mockReturnValue(underPnp)
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((text: string | Uint8Array) => { written.push(String(text)); return true })
    await import('../src/entry.ts')
    await vi.waitFor(() => expect(process.exitCode).toBe(1))
    const text = written.join('')
    expect(text).toBe(`Delorun could not leave Yarn's Plug'n'Play: spawn ENOENT. Set "nodeLinker: node-modules" in .yarnrc.yml, or run "npx delorun" instead.\n`)
    vi.doUnmock('../src/pnp.ts')
  })

  it('does not load the re-run module without Plug\'n\'Play', async () => {
    const leavePnp = vi.fn()
    vi.doMock('../src/pnp.ts', () => ({ leavePnp, signalStatus: () => 1 }))
    vi.doMock('../src/bin.ts', () => ({ main: () => Promise.resolve(0) }))
    await import('../src/entry.ts')
    await vi.waitFor(() => expect(process.exitCode).toBe(0))
    expect(leavePnp).not.toHaveBeenCalled()
    vi.doUnmock('../src/pnp.ts')
  })
})

describe('the built entry under Plug\'n\'Play', () => {
  it('refuses a second re-run with one line and exit 1, and reads and writes nothing', async () => {
    const work = await mkdtemp(join(tmpdir(), 'delorun-launcher-pnp-'))
    try {
      const fixture = await fixtureRelease()
      await writeFile(join(work, 'root.json'), fixture.roots[0]!)
      const built = await buildLauncher({ roots: [join(work, 'root.json')], out: join(work, 'out'), version: '0.0.1-pnp' })
      // The preload makes the built entry see Plug'n'Play, as Yarn's `--require .pnp.cjs` does.
      await writeFile(join(work, 'pnp.cjs'), "Object.defineProperty(process.versions, 'pnp', { value: '3' })\n")
      const home = join(work, 'home')
      // This process is the entry's parent, so the marker says the entry is already the re-run.
      const env = { PATH: process.env.PATH ?? '', DELORUN_HOME: home, [PNP_RERUN_ENV]: String(process.pid) }
      const finished = spawnSync(process.execPath, ['--require', join(work, 'pnp.cjs'), join(built.directory, 'dist', 'bin.js'), '--version'], { encoding: 'utf8', env, timeout: 50_000 })
      expect(finished.status, `signal ${String(finished.signal)}: ${finished.stderr}`).toBe(1)
      expect(finished.stdout).toBe('')
      expect(finished.stderr).toBe(`${loopRefusal()}\n`)
      await expect(readdir(home)).rejects.toMatchObject({ code: 'ENOENT' })
      const entry = await readFile(join(built.directory, 'dist', 'bin.js'), 'utf8')
      expect(entry.match(/^import .*$/gmu) ?? []).toEqual([])
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 120_000)
})
