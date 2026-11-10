/**
 * Proves how the session lock handles a failing kernel lock call: contention
 * (`EAGAIN`, `EWOULDBLOCK`) reports the lock as held by another writer, any other
 * failure propagates, and in both cases the lock file handle is closed so the
 * delete leaves nothing open.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_LOCK_FILENAME, takeSessionLock } from '../src/lease.ts'

vi.mock('@deepseek-ai/node-addon-system/flock', () => ({ tryLockExclusive: vi.fn() }))

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delo-trash-flock-'))
  writeFileSync(join(directory, SESSION_LOCK_FILENAME), '')
})

afterEach(() => {
  vi.mocked(tryLockExclusive).mockReset()
  rmSync(directory, { recursive: true, force: true })
})

/** A rejection carrying a system error code. */
function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('takeSessionLock when the kernel lock call fails', () => {
  it.each(['EAGAIN', 'EWOULDBLOCK'])('reports the lock as held by another writer on %s', async code => {
    vi.mocked(tryLockExclusive).mockRejectedValueOnce(errno(code))

    expect(await takeSessionLock(directory, 'linux')).toBeUndefined()
  })

  it('propagates a failure that is not contention', async () => {
    vi.mocked(tryLockExclusive).mockRejectedValueOnce(errno('EBADF'))

    await expect(takeSessionLock(directory, 'linux')).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('closes the lock file handle it opened when the lock call fails', async () => {
    vi.mocked(tryLockExclusive).mockRejectedValueOnce(errno('EAGAIN'))
    await takeSessionLock(directory, 'linux')
    const lockedFd = vi.mocked(tryLockExclusive).mock.calls[0]![0]

    expect(() => writeFileSync(lockedFd, 'x')).toThrowError(expect.objectContaining({ code: 'EBADF' }))
  })

  it('holds the lock and releases it when the kernel grants it', async () => {
    vi.mocked(tryLockExclusive).mockResolvedValueOnce(undefined)

    const lock = await takeSessionLock(directory, 'linux')

    await expect(lock!.release()).resolves.toBeUndefined()
  })

  it('takes no lock on Windows, where the backend holds a semaphore instead', async () => {
    expect(await takeSessionLock(join(directory, 'sub'), 'win32')).toBeUndefined()
    expect(tryLockExclusive).not.toHaveBeenCalled()
  })

  it('has no writer to exclude when the directory holds no lock file', async () => {
    mkdirSync(join(directory, 'empty'))

    const lock = await takeSessionLock(join(directory, 'empty'), 'linux')

    await expect(lock!.release()).resolves.toBeUndefined()
    expect(tryLockExclusive).not.toHaveBeenCalled()
  })
})
