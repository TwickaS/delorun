/**
 * Mutations through a directory that is replaced by a link to another directory, standing in for a protected home,
 * after the provider resolved and checked the target: edits must not return the other file's text, and writes, creates
 * and deletes must not land in or remove from the other directory.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as fsio from '../src/fsio.ts'
import { LocalFileSystem } from '../src/index.ts'

afterEach(() => { vi.restoreAllMocks() })

/** A workspace with `flip/` and a `home/` beside it, each holding `key`; the provider resolves through `flip/`. */
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-path-swap-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const flip = join(root, 'ws', 'flip')
  mkdirSync(home)
  mkdirSync(flip, { recursive: true })
  writeFileSync(join(home, 'key'), 'secret-key\n')
  writeFileSync(join(flip, 'key'), 'decoy\n')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: join(root, 'ws') })
  const fs = ctx.fs as LocalFileSystem
  /** Replace `flip/` by a link to the home the next time the provider probes a target. */
  const swapAfterProbe = () => {
    const probe = fsio.probe
    vi.spyOn(fsio, 'probe').mockImplementationOnce(async (path) => {
      const info = await probe(path)
      rmSync(flip, { recursive: true })
      symlinkSync(home, flip, 'dir')
      return info
    })
  }
  return { fs, home, flip, swapAfterProbe }
}

describe.skipIf(process.platform === 'win32')('a directory replaced by a link after the provider checked the target', () => {
  it('fails an edit instead of matching or returning the other file\'s text', async () => {
    const { fs, home, swapAfterProbe } = await setup()
    const target = await fs.resolve('flip/key')
    swapAfterProbe()
    const edit = fs.editText(target, { oldString: '\n', newString: ' edited\n', replaceAll: false })
    await expect(edit).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await expect(edit).rejects.not.toThrow('secret-key')
    expect(readFileSync(join(home, 'key'), 'utf8')).toBe('secret-key\n')
  })

  it('fails a write without overwriting the other directory\'s file', async () => {
    const { fs, home, swapAfterProbe } = await setup()
    const existing = await fs.resolve('flip/key')
    swapAfterProbe()
    await expect(fs.writeText(existing, 'overwritten\n')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(readFileSync(join(home, 'key'), 'utf8')).toBe('secret-key\n')
  })

  it('fails a create-if-absent write without creating the file in the other directory', async () => {
    const { fs, home, swapAfterProbe } = await setup()
    const target = await fs.resolve('flip/profile.patch.yml')
    swapAfterProbe()
    await expect(fs.writeText(target, '- id: planted\n', { kind: 'createIfAbsent' })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(existsSync(join(home, 'profile.patch.yml'))).toBe(false)
  })

  it('fails a write into a missing directory without creating it in the other directory', async () => {
    const { fs, home, swapAfterProbe } = await setup()
    const target = await fs.resolve('flip/sub/new.txt')
    swapAfterProbe()
    await expect(fs.writeText(target, 'x\n', { kind: 'createIfAbsent' })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(existsSync(join(home, 'sub'))).toBe(false)
  })

  it('fails a delete without removing the other directory\'s file', async () => {
    const { fs, home, swapAfterProbe } = await setup()
    const target = await fs.resolve('flip/key')
    swapAfterProbe()
    await expect(fs.deleteFile(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(readFileSync(join(home, 'key'), 'utf8')).toBe('secret-key\n')
  })
})
