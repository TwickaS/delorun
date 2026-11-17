/**
 * The fixed invariant that no read opens another process's environment or memory (`/proc/<pid>/environ`, `/proc/<pid>/mem`):
 * the Host's environment holds its secrets. A direct path, the `self` and `thread-self` spellings, a symlink to one and
 * the Host's own pid are all refused after realpath resolution. Linux only: other systems have no `/proc`.
 *
 * Each test's comment names the check whose removal makes it fail.
 */
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import { readByteWindow, readForEdit, readTextForDiff, readWholeBytes, readWholeText, refuseProcessSecret, resolveLocalTarget, streamWholeText } from '../src/fsio.ts'

const linux = process.platform === 'linux'
const REFUSAL = expect.objectContaining({ code: 'FS_SANDBOX_DENIED', message: expect.stringContaining('never reads another process\'s environment or memory') })

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-proc-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe.skipIf(!linux)('a process\'s environment and memory', () => {
  const paths = () => [
    '/proc/self/environ', '/proc/thread-self/environ', `/proc/${String(process.pid)}/environ`, `/proc/${String(process.pid)}/mem`,
    '/proc/self/mem', `/proc/self/task/${String(process.pid)}/environ`, '/proc/1/environ',
  ]

  it('are refused at resolution, whichever way the path is spelled', async () => {
    for (const path of paths()) {
      // Pins the realpath match: `self` and `thread-self` resolve to a pid form that the check recognises.
      await expect(resolveLocalTarget('/', path), path).rejects.toEqual(REFUSAL)
    }
  })

  it('are refused through a symlink', async () => {
    await symlink('/proc/self/environ', join(dir, 'link-environ'))
    await symlink('/proc/self', join(dir, 'link-self'))
    await expect(resolveLocalTarget(dir, 'link-environ')).rejects.toEqual(REFUSAL)
    await expect(resolveLocalTarget(dir, 'link-self/environ')).rejects.toEqual(REFUSAL)
    await expect(resolveLocalTarget(dir, 'link-self/mem')).rejects.toEqual(REFUSAL)
  })

  it('are refused by every reader even for a target built without resolution', async () => {
    const target = { displayPath: '/proc/self/environ', targetKey: FsTargetKey(`/proc/${String(process.pid)}/environ`) }
    await expect(readWholeText(target)).rejects.toEqual(REFUSAL)
    await expect(readWholeBytes(target, undefined, 1024)).rejects.toEqual(REFUSAL)
    await expect(readByteWindow(target, { offset: 0, length: 8 })).rejects.toEqual(REFUSAL)
    await expect((async () => { for await (const chunk of streamWholeText(target)) void chunk })()).rejects.toEqual(REFUSAL)
    await expect(readForEdit(String(target.targetKey), target.displayPath)).rejects.toEqual(REFUSAL)
    await expect(readTextForDiff(String(target.targetKey), 1024)).rejects.toEqual(REFUSAL)
  })

  it('leave other /proc files and similarly named files readable', async () => {
    expect((await resolveLocalTarget('/', '/proc/self/status')).targetKey).toMatch(/^\/proc\/\d+\/status$/)
    expect(() => { refuseProcessSecret({ displayPath: 'x', targetKey: FsTargetKey('/home/a/proc/1/environ') }) }).not.toThrow()
    expect(() => { refuseProcessSecret({ displayPath: 'x', targetKey: FsTargetKey('/proc/1/environment') }) }).not.toThrow()
    expect(FsError).toBeDefined()
  })
})
