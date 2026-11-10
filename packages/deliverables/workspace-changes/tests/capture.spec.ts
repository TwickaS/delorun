/** Whole-file capture storage, its refusal of entries it did not write, and content comparison. */
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CaptureStore, sameCapture } from '../src/capture.ts'
import { PrivateTree } from '../src/files.ts'
import { scratchDir } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const signal = new AbortController().signal
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

/** A store over one Session's private tree created under `root`; the same tree is yielded on every call. */
async function storeUnder(root: string): Promise<{ store: CaptureStore; tree: PrivateTree }> {
  const tree = await PrivateTree.create(root)
  return { store: new CaptureStore(() => Promise.resolve(tree)), tree }
}

describe('CaptureStore', () => {
  it('stores text once by content, reads no more than the cap, and classifies absent, oversized, binary, and non-regular paths', async () => {
    const root = await scratchDir('dsh-capture-', cleanups)
    const { store, tree } = await storeUnder(root)
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(root, 'same.txt'), 'one\ntwo\n')
    await writeFile(join(root, 'big.txt'), 'x'.repeat(17))
    await writeFile(join(root, 'bin.dat'), Uint8Array.of(65, 0, 66))
    await mkdir(join(root, 'dir'))
    await symlink(join(root, 'a.txt'), join(root, 'link.txt'))
    const a = await store.capture(join(root, 'a.txt'), 16)
    const same = await store.capture(join(root, 'same.txt'), 16)
    expect(a).toMatchObject({ kind: 'file', binary: false })
    expect(same).toEqual(a)
    if (a?.kind !== 'file' || same === undefined) throw new Error('expected a stored copy')
    expect(await store.read(a, signal)).toBe('one\ntwo\n')
    expect(await readdir(join(tree.path, 'captures'))).toHaveLength(1)
    expect(await store.capture(join(root, 'big.txt'), 16)).toEqual({ kind: 'oversized' })
    expect(await store.capture(join(root, 'missing.txt'), 16)).toEqual({ kind: 'absent' })
    expect(await store.capture(join(root, 'bin.dat'), 16)).toMatchObject({ kind: 'file', binary: true })
    expect(await store.capture(join(root, 'dir'), 16)).toBeUndefined()
    expect(await store.capture(join(root, 'link.txt'), 16)).toBeUndefined()
    // The cap is inclusive: exactly `maxBytes` is stored, one byte more is not.
    await writeFile(join(root, 'edge.txt'), 'y'.repeat(16))
    expect(await store.capture(join(root, 'edge.txt'), 16)).toMatchObject({ kind: 'file' })
    expect(sameCapture({ kind: 'absent' }, { kind: 'absent' })).toBe(true)
    expect(sameCapture({ kind: 'absent' }, { kind: 'oversized' })).toBe(false)
    expect(sameCapture(a, same)).toBe(true)
    expect(sameCapture(a, { kind: 'file', file: 'elsewhere', binary: false })).toBe(false)
    // Unread content is never known to match: two oversized sides may differ.
    expect(sameCapture({ kind: 'oversized' }, { kind: 'oversized' })).toBe(false)
    expect(sameCapture({ kind: 'oversized' }, a)).toBe(false)
  })

  it('refuses a captures entry it did not write instead of treating it as already captured', async () => {
    const root = await scratchDir('dsh-capture-planted-', cleanups)
    const { store, tree } = await storeUnder(root)
    await writeFile(join(root, 'first.txt'), 'first\n')
    await writeFile(join(root, 'edited.txt'), 'original\n')
    await store.capture(join(root, 'first.txt'), 1024)
    // A copy named by the edited file's content, holding a harmless marker instead.
    await writeFile(join(tree.path, 'captures', sha1('original\n')), 'planted-marker\n')
    await expect(store.capture(join(root, 'edited.txt'), 1024)).rejects.toThrow('EEXIST')
  })

  it('refuses a captures directory it did not create', async () => {
    const root = await scratchDir('dsh-capture-planted-dir-', cleanups)
    const elsewhere = await scratchDir('dsh-capture-elsewhere-', cleanups)
    const { store, tree } = await storeUnder(root)
    await symlink(elsewhere, join(tree.path, 'captures'))
    await writeFile(join(root, 'edited.txt'), 'original\n')
    await expect(store.capture(join(root, 'edited.txt'), 1024)).rejects.toThrow('EEXIST')
    expect(await readdir(elsewhere)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('reads a copy back only as the regular file it wrote, with the bytes it wrote', async () => {
    const root = await scratchDir('dsh-capture-readback-', cleanups)
    const { store } = await storeUnder(root)
    await writeFile(join(root, 'a.txt'), 'one\n')
    await writeFile(join(root, 'b.txt'), 'two\n')
    await writeFile(join(root, 'marker.txt'), 'marker\n')
    const a = await store.capture(join(root, 'a.txt'), 1024)
    const b = await store.capture(join(root, 'b.txt'), 1024)
    if (a?.kind !== 'file' || b?.kind !== 'file') throw new Error('expected stored copies')
    await writeFile(a.file, 'changed\n')
    await expect(store.read(a, signal)).rejects.toThrow('changed after it was written')
    await rm(b.file)
    await symlink(join(root, 'marker.txt'), b.file)
    await expect(store.read(b, signal)).rejects.toThrow('ELOOP')
    expect(await readFile(join(root, 'marker.txt'), 'utf8')).toBe('marker\n')
  })
})
