/**
 * The roots a launcher package ships are read from its own `roots/` directory, by `@delo/install`'s rule.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInstallError } from '@delo/install'
import { readEmbeddedRoots } from '../src/root.ts'
import { fixtureRelease } from '../../install/tests/support.ts'

let directory: string | undefined

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('the roots a package ships', () => {
  it('reads roots/ under the package directory, and refuses a package without one', async () => {
    const fixture = await fixtureRelease()
    directory = await mkdtemp(join(tmpdir(), 'delo-launcher-roots-'))
    const missing: unknown = await readEmbeddedRoots(directory).then(() => undefined, (error: unknown) => error)
    expect(isInstallError(missing, 'NO_TRUSTED_ROOT')).toBe(true)
    await mkdir(join(directory, 'roots'))
    await writeFile(join(directory, 'roots', '1.root.json'), fixture.roots[0]!)
    expect((await readEmbeddedRoots(directory)).map(Buffer.from)).toEqual([Buffer.from(fixture.roots[0]!)])
  })
})
