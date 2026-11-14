/**
 * The runtime the CLI runs as (`delorun/apps/cli/src/update/runtime.ts`): a file under `<home>/runtimes/<version>/` runs
 * that stored version, any other file runs this package's own version with no store, and a successor's handover is
 * read only from a socket or a pipe on its descriptor.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDelorunHome } from '@delorun/home'
import { afterEach, describe, expect, it } from 'vitest'
import { inheritedHandover, runningVersion, runtimeOfFile } from '../../src/update/runtime.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** The CLI package's manifest version. */
const MANIFEST_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version

describe('runtimeOfFile', () => {
  it('names the stored version of a file under the home\'s runtimes', () => {
    expect(runtimeOfFile('/home/x/.delorun', '/home/x/.delorun/runtimes/1.2.3/lib/start.js')).toEqual({ version: '1.2.3', store: true })
    expect(runtimeOfFile('/home/x/.delorun', '/home/x/.delorun/runtimes/1.2.3')).toEqual({ version: '1.2.3', store: true })
  })

  it('names this package\'s version for a file elsewhere, or under a runtimes entry that is not a version', () => {
    expect(runtimeOfFile('/home/x/.delorun', '/src/delorun/apps/cli/src/start.ts')).toEqual({ version: MANIFEST_VERSION, store: false })
    expect(runtimeOfFile('/home/x/.delorun', '/home/x/.delorun/runtimes/current')).toEqual({ version: MANIFEST_VERSION, store: false })
    expect(runningVersion()).toBe(MANIFEST_VERSION)
  })

  it('names the stored version of a file under a home whose parent is reached through a symbolic link, as the resolved home names it', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dcr-')))
    directories.push(directory)
    const real = join(directory, 'real', 'home')
    mkdirSync(join(real, 'runtimes', '1.2.3', 'lib'), { recursive: true })
    symlinkSync(join(directory, 'real'), join(directory, 'link'))
    const home = await resolveDelorunHome({ DELORUN_HOME: join(directory, 'link', 'home') })
    expect(home.path).toBe(real)
    // A module's own path, from `import.meta.url`, has its links resolved.
    expect(runtimeOfFile(home.path, join(real, 'runtimes', '1.2.3', 'lib', 'start.js'))).toEqual({ version: '1.2.3', store: true })
  })
})

describe('inheritedHandover', () => {
  it('reads no handover from a closed descriptor or a regular file', async () => {
    expect(await inheritedHandover(2 ** 20)).toBeUndefined()
    const directory = mkdtempSync(join(tmpdir(), 'dcr-'))
    directories.push(directory)
    writeFileSync(join(directory, 'file'), '')
    const fd = openSync(join(directory, 'file'), 'r')
    try {
      expect(await inheritedHandover(fd)).toBeUndefined()
    } finally {
      closeSync(fd)
    }
  })

  it('reads the handover from a pipe on its descriptor, refusing a first line that is not one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dcr-'))
    directories.push(directory)
    const fifo = join(directory, 'handover')
    execFileSync('mkfifo', [fifo], { timeout: 30_000 })
    // Read and write, so the open does not wait for a writer; the line written is the one the pipe reads.
    const fd = openSync(fifo, 'r+')
    writeSync(fd, 'not a handover line\n')
    await expect(inheritedHandover(fd)).rejects.toThrow(/^the handover line is not valid/u)
  })
})
