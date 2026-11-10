/**
 * The launcher's Node requirement: an older Node gets one plain line and exit status 1 before the launcher's main
 * module is loaded, and the published package declares the same range.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(line).toBe('Delo needs Node 24.9 or newer to start, and this is Node 20.11.1. Install a newer Node from https://nodejs.org, then run the same command again.')
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

  it('imports only the version check statically, so an older Node refuses before it reads anything newer', async () => {
    const entry = await readFile(join(import.meta.dirname, '..', 'src', 'entry.ts'), 'utf8')
    expect(entry.match(/^import .*$/gmu)).toEqual(["import { nodeRefusal } from './node-version.ts'"])
  })
})
