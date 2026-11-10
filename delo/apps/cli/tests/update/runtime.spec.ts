/**
 * The runtime the CLI runs as (`delo/apps/cli/src/update/runtime.ts`): a file under `<home>/runtimes/<version>/` runs
 * that stored version, any other file runs this package's own version with no store, and a successor's handover is
 * read only from a socket or a pipe on its descriptor.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(runtimeOfFile('/home/x/.delo', '/home/x/.delo/runtimes/1.2.3/lib/start.js')).toEqual({ version: '1.2.3', store: true })
    expect(runtimeOfFile('/home/x/.delo', '/home/x/.delo/runtimes/1.2.3')).toEqual({ version: '1.2.3', store: true })
  })

  it('names this package\'s version for a file elsewhere, or under a runtimes entry that is not a version', () => {
    expect(runtimeOfFile('/home/x/.delo', '/src/delo/apps/cli/src/start.ts')).toEqual({ version: MANIFEST_VERSION, store: false })
    expect(runtimeOfFile('/home/x/.delo', '/home/x/.delo/runtimes/current')).toEqual({ version: MANIFEST_VERSION, store: false })
    expect(runningVersion()).toBe(MANIFEST_VERSION)
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
    execFileSync('mkfifo', [fifo])
    // Read and write, so the open does not wait for a writer; the line written is the one the pipe reads.
    const fd = openSync(fifo, 'r+')
    writeSync(fd, 'not a handover line\n')
    await expect(inheritedHandover(fd)).rejects.toThrow(/^the handover line is not valid/u)
  })
})
