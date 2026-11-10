/**
 * Proves how the store and the purge effects handle file system outcomes a
 * test cannot produce without interleaving: a directory that vanishes between
 * the root check and its listing, and a move across devices. A rename that
 * fails with `EXDEV` falls back to copy-and-remove, and any other rename
 * failure leaves the source untouched and propagates. The fallback copies with
 * Node's own `cp`, keeping each file's mode.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeSessionDirectory } from '../src/effects.ts'
import { moveDirectory } from '../src/store.ts'
import { TrashService } from '../src/service.ts'
import { sessionDirectoryPath } from '../src/paths.ts'


vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, cp: vi.fn(actual.cp), readdir: vi.fn(actual.readdir), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delo-trash-races-'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A rejection carrying a system error code. */
function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('removeSessionDirectory', () => {
  it('removes nothing from a sessions root that vanishes before it is listed', async () => {
    const root = join(base, 'sessions')
    mkdirSync(root)
    vi.mocked(readdir).mockRejectedValueOnce(errno('ENOENT'))

    expect(await removeSessionDirectory(root, 'chat-a')).toBeUndefined()
  })
})

describe('moveDirectory', () => {
  /** Plant a source tree with one nested file. */
  function plantSource(): string {
    const from = join(base, 'from')
    mkdirSync(join(from, 'nested'), { recursive: true })
    writeFileSync(join(from, 'nested', 'session.jsonl'), 'content\n')
    return from
  }

  it('copies and removes the source when the rename crosses devices', async () => {
    const from = plantSource()
    const to = join(base, 'to')
    vi.mocked(rename).mockRejectedValueOnce(errno('EXDEV'))

    await moveDirectory(from, to)

    expect(vi.mocked(cp)).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(to, 'nested', 'session.jsonl'), 'utf8')).toBe('content\n')
    expect(existsSync(from)).toBe(false)
  })

  it('propagates a rename failure that is not a device crossing and keeps the source', async () => {
    const from = plantSource()
    const to = join(base, 'to')
    vi.mocked(rename).mockRejectedValueOnce(errno('EACCES'))

    await expect(moveDirectory(from, to)).rejects.toMatchObject({ code: 'EACCES' })
    expect(existsSync(join(from, 'nested', 'session.jsonl'))).toBe(true)
    expect(existsSync(to)).toBe(false)
  })
})

describe('a cross-device move whose removal fails partway', () => {
  it('leaves both copies, and a restore overwrites neither', async () => {
    const sessionsRoot = join(base, 'sessions')
    const origin = sessionDirectoryPath(sessionsRoot, '/work', 'chat-a')
    mkdirSync(origin, { recursive: true })
    writeFileSync(join(origin, 'session.jsonl'), 'content\n')
    const trash = new TrashService({ root: join(base, 'trash'), stores: { sessionsRoot } })
    const realRename = vi.mocked(rename).getMockImplementation()!
    const realRm = vi.mocked(rm).getMockImplementation()!
    vi.mocked(rename).mockImplementation(async (from, to) => from === origin ? Promise.reject(errno('EXDEV')) : realRename(from, to))
    vi.mocked(rm).mockImplementation(async (path, options) => path === origin ? Promise.reject(errno('EBUSY')) : realRm(path, options))

    await expect(trash.deleteChat({ sessionId: 'chat-a', cwd: '/work' })).rejects.toMatchObject({ code: 'EBUSY' })
    const [item] = await trash.list()

    await expect(trash.restore(item!.id)).rejects.toMatchObject({ code: 'TRASH_RESTORE_CONFLICT' })
    expect(readFileSync(join(origin, 'session.jsonl'), 'utf8')).toBe('content\n')
    expect(existsSync(join(base, 'trash', 'items', item!.id, 'chats', '--work--', 'chat-a', 'session.jsonl'))).toBe(true)
    vi.mocked(rename).mockImplementation(realRename)
    vi.mocked(rm).mockImplementation(realRm)
  })
})
