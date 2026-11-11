import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyHarnessChange, createHarnessCopy, harnessChanges } from '../src/harness.ts'
import { checkComposedTree, prepareComposedTree } from '../src/harness-tree.ts'
import { harnessCopyDirectory, harnessRunDirectory } from '../src/paths.ts'
import { harnessFixture, RUNTIME, SIGNED_FILES, START_FILE, terminal } from './harness-fixture.ts'
import { rejection } from './support.ts'

/** What the mocked modules do instead of the real call, while set. */
const faults: { readObject?: Buffer, link?: string } = {}

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
      throw Object.assign(new Error(`link refused: ${faults.link}`), { code: faults.link })
    },
  }
})

afterEach(() => {
  delete faults.readObject
  delete faults.link
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

  it('a hard link that fails for another reason fails the build', async () => {
    const { home, signed } = await approved()
    faults.link = 'EIO'
    await expect(prepareComposedTree(home, RUNTIME, signed)).rejects.toThrow('link refused: EIO')
  })
})
