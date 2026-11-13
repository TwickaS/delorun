import { chmodSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyHarnessChange, createHarnessCopy, harnessChanges } from '../src/harness.ts'
import { checkComposedTree, prepareComposedTree } from '../src/harness-tree.ts'
import { harnessCopyDirectory, harnessRunDirectory } from '../src/paths.ts'
import { harnessFixture, RUNTIME, SIGNED_FILES, START_FILE, terminal } from './harness-fixture.ts'
import { rejection } from './support.ts'

/** What the mocked modules do instead of the real call, while set. */
const faults: { readObject?: Buffer, link?: string, linkPaths?: boolean, inodes?: ReadonlyMap<string, bigint> } = {}

vi.mock('../src/store.ts', async (original) => {
  const actual = await original<typeof import('../src/store.ts')>()
  return { ...actual, readObject: async (...args: Parameters<typeof actual.readObject>) => faults.readObject ?? actual.readObject(...args) }
})

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (faults.link === undefined) return actual.link(...args)
      throw Object.assign(new Error(`link refused: ${faults.link}`), { code: faults.link }, faults.linkPaths === true ? { path: String(args[0]), dest: String(args[1]) } : {})
    },
    // The inode a file system with 64-bit inode numbers reports: exact as a bigint, rounded to the nearest double as
    // a number, as Node gives it.
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args)
      const ino = faults.inodes?.get(String(args[0]))
      if (ino === undefined) return stats
      return Object.assign(stats, { ino: typeof stats.ino === 'bigint' ? ino : Number(ino) })
    },
  }
})

afterEach(() => {
  delete faults.readObject
  delete faults.link
  delete faults.linkPaths
  delete faults.inodes
})

/**
 * A home whose runtime has one approved edit of the start file.
 * @returns the fixture.
 */
async function approved(): Promise<ReturnType<typeof harnessFixture>> {
  const fixture = harnessFixture()
  await createHarnessCopy(fixture.ctx, terminal())
  writeFileSync(join(harnessCopyDirectory(fixture.home, RUNTIME), ...START_FILE.split('/')), 'export const start = 2\n')
  await applyHarnessChange(fixture.ctx, (await harnessChanges(fixture.ctx)).changes[0]!.id, terminal())
  return fixture
}

describe('a composed tree that fails its check again', () => {
  it('a composed tree that fails its check after it was rebuilt refuses the start, naming the path', async () => {
    const { home, signed } = await approved()
    faults.readObject = Buffer.from('not the approved bytes\n')
    const refused = await rejection(prepareComposedTree(home, RUNTIME, signed), 'HARNESS_CHANGED')
    expect(refused.subject).toMatch(new RegExp(`^${harnessRunDirectory(home, RUNTIME)}/[0-9a-f]{64}/app/node_modules/@delo/cli/src/start\\.js$`, 'u'))
    expect(refused.detail).toContain('not the signed or approved file')
  })

  it('copies each signed file where the filesystem refuses a hard link, and the copy passes the check by its bytes', async () => {
    for (const code of ['EXDEV', 'EPERM', 'ENOTSUP']) {
      const { home, signed } = await approved()
      faults.link = code
      const root = (await prepareComposedTree(home, RUNTIME, signed))!.directory
      expect(readFileSync(join(root, 'app/package.json'), 'utf8')).toBe(SIGNED_FILES['app/package.json'])
      expect(lstatSync(join(root, 'app/package.json')).ino).not.toBe(lstatSync(join(signed.directory, 'app/package.json')).ino)
      expect(lstatSync(join(root, 'node/bin/node')).mode & 0o777).toBe(0o555)
      await checkComposedTree(home, RUNTIME, signed, root)
    }
  })

  it('a path in the way of a hard link refuses the start with HARNESS_CHANGED naming it', async () => {
    const { home, signed } = await approved()
    faults.link = 'EEXIST'
    faults.linkPaths = true
    const refused = await rejection(prepareComposedTree(home, RUNTIME, signed), 'HARNESS_CHANGED')
    expect(refused.subject).toMatch(new RegExp(`^${harnessRunDirectory(home, RUNTIME)}/\\.[0-9a-f]{64}\\.delo-tmp-[0-9a-f]{16}/app/node_modules/@delo/cli/run\\.sh$`, 'u'))
    expect(refused.detail).toContain('is already there to build the harness with your approved changes')
    faults.link = 'ENOTDIR'
    faults.linkPaths = false
    const unnamed = await rejection(prepareComposedTree(home, RUNTIME, signed), 'HARNESS_CHANGED')
    expect(unnamed.subject).toMatch(new RegExp(`^${harnessRunDirectory(home, RUNTIME)}/[0-9a-f]{64}$`, 'u'))
    expect(unnamed.detail).toContain('is a file where Delo needs a directory')
  })

  it('a changed file whose inode differs from the installation\'s only past 2^53 is not taken for its hard link', async () => {
    const { home, signed } = await approved()
    const root = (await prepareComposedTree(home, RUNTIME, signed))!.directory
    const mine = join(root, 'app/package.json')
    chmodSync(join(root, 'app'), 0o755)
    rmSync(mine)
    writeFileSync(mine, '{"name":"other"}\n', { mode: 0o444 })
    faults.inodes = new Map([[mine, 2n ** 60n + 1n], [join(signed.directory, 'app/package.json'), 2n ** 60n]])
    expect(Number(2n ** 60n + 1n)).toBe(Number(2n ** 60n))
    const refused = await rejection(checkComposedTree(home, RUNTIME, signed, root), 'HARNESS_CHANGED')
    expect(refused.subject).toBe(mine)
  })

  it('a hard link that fails for another reason fails the build', async () => {
    const { home, signed } = await approved()
    faults.link = 'EIO'
    await expect(prepareComposedTree(home, RUNTIME, signed)).rejects.toThrow('link refused: EIO')
  })
})
