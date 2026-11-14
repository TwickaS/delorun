/**
 * Specs of a pinned path that names a FIFO, such as a link swapped for one between the check that an argument names a
 * regular file and the open: the pin is refused at once instead of waiting for a writer, so neither the review nor the
 * plugin's disposal hangs.
 */
import { spawnSync } from 'node:child_process'
import { constants, closeSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pinFile } from '../src/pins.ts'

let root: string
let fifo: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-mcp-pin-fifo-')))
  fifo = join(root, 'server.js')
  const made = spawnSync('mkfifo', [fifo], { timeout: 30_000 })
  if (made.status !== 0) throw new Error(`mkfifo exited ${String(made.status)}`)
})

afterEach(() => {
  // A reader still waiting in open, as one without O_NONBLOCK would, is released by any open of the other end.
  closeSync(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK))
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('a pinned path that names a FIFO', () => {
  it('is refused as not a regular file without waiting for a writer', async () => {
    await expect(pinFile(fifo)).rejects.toThrow(`the file ${JSON.stringify(fifo)} is not a regular file`)
  }, 5_000)
})
