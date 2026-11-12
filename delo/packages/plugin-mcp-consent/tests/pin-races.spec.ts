/**
 * Specs of the file hasher's refusals of a file that changes while it is pinned: a status that differs after the read,
 * and a path that resolves to another file after the read. The file system's `open` and `realpath` are wrapped so a
 * spec can change what the second look sees. Isolated file so the vi.mock of `node:fs/promises` doesn't reach other suites.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { open, realpath } = vi.hoisted(() => ({ open: vi.fn(), realpath: vi.fn() }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  open.mockImplementation(actual.open)
  realpath.mockImplementation(actual.realpath)
  return { ...actual, open, realpath }
})

import { FileHasher } from '../src/pins.ts'

let root: string
let path: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-mcp-pin-races-')))
  path = join(root, 'server.js')
  writeFileSync(path, 'console.log("accepted")\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a file that changes while it is pinned', () => {
  it('is refused when its status after the read differs from its status before', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    open.mockImplementationOnce(async (file: string, flags: string) => {
      const handle: FileHandle = await actual.open(file, flags)
      const stat = handle.stat.bind(handle)
      let looks = 0
      return Object.assign(handle, {
        stat: async (options: { bigint: true }) => {
          const info = await stat(options)
          looks++
          return looks === 1 ? info : Object.assign(info, { ctimeNs: info.ctimeNs + 1n })
        },
      })
    })
    await expect(new FileHasher().pin(path)).rejects.toThrow(`the file ${JSON.stringify(path)} changed while it was read`)
  })

  it('is refused when its path resolves to another file after the read', async () => {
    realpath.mockResolvedValueOnce(path).mockResolvedValueOnce(join(root, 'other.js'))
    await expect(new FileHasher().pin(path)).rejects.toThrow(`the file ${JSON.stringify(path)} resolved to another file while it was read`)
  })

  it('is refused when its path no longer resolves after the read', async () => {
    realpath.mockResolvedValueOnce(path).mockRejectedValueOnce(new Error('ENOENT'))
    await expect(new FileHasher().pin(path)).rejects.toThrow(`the file ${JSON.stringify(path)} resolved to another file while it was read`)
  })
})
