/**
 * What a home remembers under `trust/`: each file reads back what was written, a file that is absent is absent, and
 * every file that does not read, or cannot be written, refuses with `TRUST_STATE_INVALID` instead of being replaced.
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInstallError } from '../src/errors.ts'
import {
  readStoredRootBytes,
  readStoredRootChain,
  readStoredTimestamp,
  trustFile,
  writeStoredRootChain,
  writeStoredTimestamp,
  writeTrustedRoot,
} from '../src/state.ts'
import { fixtureRelease } from './support.ts'

let homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.map(async (home) => {
    await chmod(join(home, 'trust', 'roots'), 0o700).catch(() => undefined)
    await chmod(join(home, 'trust'), 0o700).catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  }))
  homes = []
})

/**
 * A temporary Delo home.
 * @returns its path.
 */
async function scratchHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'delo-install-state-'))
  homes.push(home)
  return home
}

/**
 * A home whose `trust/` holds a file at a path, written at mode 0600.
 * @param name - the path below `trust/`.
 * @param content - the file's content.
 * @returns the home.
 */
async function homeWith(name: string, content: string): Promise<string> {
  const home = await scratchHome()
  const path = join(home, 'trust', name)
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, content, { mode: 0o600 })
  return home
}

/**
 * Expect a step to refuse with `TRUST_STATE_INVALID`.
 * @param step - the step.
 * @returns the refusal's detail.
 */
async function invalid(step: Promise<unknown>): Promise<string> {
  const error: unknown = await step.then(() => undefined, (failure: unknown) => failure)
  expect(isInstallError(error, 'TRUST_STATE_INVALID'), error instanceof Error ? error.message : String(error)).toBe(true)
  return (error as { detail: string }).detail
}

describe('the stored timestamp', () => {
  it('is absent before an install, and reads back its version and bytes', async () => {
    const home = await scratchHome()
    expect(await readStoredTimestamp(home)).toBeUndefined()
    await writeStoredTimestamp(home, Buffer.from('{"signed":{"version":4},"signatures":[]}'))
    expect(await readStoredTimestamp(home)).toEqual({ version: 4, bytes: Buffer.from('{"signed":{"version":4},"signatures":[]}') })
  })

  it('refuses a file that is not JSON, names no version, or is not a file', async () => {
    expect(await invalid(readStoredTimestamp(await homeWith('timestamp.json', 'not json')))).toContain('is not JSON')
    expect(await invalid(readStoredTimestamp(await homeWith('timestamp.json', '5')))).toContain('no signed version')
    expect(await invalid(readStoredTimestamp(await homeWith('timestamp.json', '{"signed":{"version":0}}')))).toContain('no signed version')
    expect(await invalid(readStoredTimestamp(await homeWith('timestamp.json', '{"signed":{"version":1.5}}')))).toContain('no signed version')
    const home = await scratchHome()
    await mkdir(join(home, 'trust', 'timestamp.json'), { recursive: true, mode: 0o700 })
    expect(await invalid(readStoredTimestamp(home))).toContain('cannot be read')
  })
})

describe('the stored root', () => {
  it('is absent before an install, and reads back what was written', async () => {
    const home = await scratchHome()
    expect(await readStoredRootBytes(home)).toBeUndefined()
    await writeTrustedRoot(home, Buffer.from('root bytes'))
    expect(await readStoredRootBytes(home)).toEqual(Buffer.from('root bytes'))
    expect(await readFile(trustFile(home, 'root.json'), 'utf8')).toBe('root bytes')
  })

  it('refuses to be written when trust is a file', async () => {
    const home = await scratchHome()
    await writeFile(join(home, 'trust'), 'in the way')
    expect(await invalid(writeTrustedRoot(home, Buffer.from('root')))).toContain('cannot be written')
  })
})

describe('the stored root chain', () => {
  it('is empty before an install walked one, and reads back the roots in version order, ignoring other files', async () => {
    const fixture = await fixtureRelease()
    const home = await scratchHome()
    expect(await readStoredRootChain(home)).toEqual([])
    await writeStoredRootChain(home, fixture.roots)
    await writeFile(join(home, 'trust', 'roots', 'notes.txt'), 'not a root')
    expect(await readStoredRootChain(home)).toEqual([Buffer.from(fixture.roots[0]!)])
    await writeFile(join(home, 'trust', 'roots', '10.root.json'), 'ten', { mode: 0o600 })
    await writeFile(join(home, 'trust', 'roots', '2.root.json'), 'two', { mode: 0o600 })
    expect((await readStoredRootChain(home)).map(bytes => Buffer.from(bytes).toString('utf8').slice(0, 3))).toEqual([Buffer.from(fixture.roots[0]!).toString('utf8').slice(0, 3), 'two', 'ten'])
  })

  it('writes nothing for an empty chain', async () => {
    const home = await scratchHome()
    await writeStoredRootChain(home, [])
    expect(await readdir(home)).toEqual([])
  })

  it('refuses a chain directory that is not a directory, and a root that is not readable', async () => {
    const notDirectory = await homeWith('roots', 'in the way')
    expect(await invalid(readStoredRootChain(notDirectory))).toContain('cannot be read')
    const unreadable = await scratchHome()
    await mkdir(join(unreadable, 'trust', 'roots', '1.root.json'), { recursive: true, mode: 0o700 })
    expect(await invalid(readStoredRootChain(unreadable))).toContain('cannot be read')
  })

  it('refuses to store a chain when the directory cannot be made, a root does not read, or a file cannot be written', async () => {
    const fixture = await fixtureRelease()
    expect(await invalid(writeStoredRootChain(await homeWith('roots', 'in the way'), fixture.roots))).toContain('cannot be written')
    expect(await invalid(writeStoredRootChain(await scratchHome(), [Buffer.from('not a root')]))).toContain('does not read')
    const home = await scratchHome()
    await mkdir(join(home, 'trust', 'roots'), { recursive: true, mode: 0o700 })
    await chmod(join(home, 'trust', 'roots'), 0o500)
    expect(await invalid(writeStoredRootChain(home, fixture.roots))).toContain('cannot be written')
  })
})
