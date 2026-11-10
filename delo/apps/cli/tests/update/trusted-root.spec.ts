/**
 * The root every update, rollback and health check of this runtime verifies with
 * (`delo/apps/cli/src/update/trusted-root.ts`): `trust/root.json`, trusted only through the release roots the launcher
 * that started the process ships. A root a same-user process wrote over `trust/root.json`, signed by its own keys, is
 * refused, and a process the launcher did not start anchors nothing and refuses.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DELO_HOME_ENTRIES, DELO_LAUNCHER_ROOTS_ENV, TRUST_FILES } from '@delo/contract-home-layout'
import { ensureHomeTree } from '@delo/home'
import { launcherAnchor } from '../../src/update/trusted-root.ts'
import { throwawayRoot } from './support.ts'

let base: string
let home: string
let shipped: ReturnType<typeof throwawayRoot>
let launched: Record<string, string>

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dtr-')))
  home = join(base, 'h')
  await ensureHomeTree(home, 'default')
  shipped = throwawayRoot()
  mkdirSync(join(base, 'roots'))
  writeFileSync(join(base, 'roots', '1.root.json'), shipped.bytes)
  launched = { [DELO_LAUNCHER_ROOTS_ENV]: join(base, 'roots') }
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/**
 * Store a root as `trust/root.json`.
 * @param bytes - the root file.
 */
function store(bytes: Uint8Array): void {
  writeFileSync(join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root), bytes, { mode: 0o600 })
}

describe('the root a runtime the launcher started trusts', () => {
  it('is the stored root when the launcher ships it, and the launcher\'s roots are what an update walks from', async () => {
    store(shipped.bytes)
    const anchor = launcherAnchor(home, launched)
    expect(await anchor.root()).toEqual(shipped.metadata)
    expect((await anchor.shipped()).map(bytes => Buffer.from(bytes))).toEqual([shipped.bytes])
  })

  it('refuses a root written over trust/root.json that its own keys sign and no shipped root leads to', async () => {
    store(throwawayRoot().bytes)
    await expect(launcherAnchor(home, launched).root()).rejects.toMatchObject({
      code: 'ROOT_NOT_ANCHORED',
      remedies: ['reinstall'],
      detail: expect.stringContaining('is not one the launcher\'s release roots lead to'),
    })
  })

  it('refuses a home that stores no root', async () => {
    await expect(launcherAnchor(home, launched).root()).rejects.toMatchObject({ code: 'ROOT_NOT_ANCHORED', detail: expect.stringContaining('no trusted release root is stored') })
  })
})

describe('a runtime the launcher did not start', () => {
  it('anchors nothing and names the launcher as the way to proceed, whether the variable is absent or empty', async () => {
    store(shipped.bytes)
    for (const env of [{}, { [DELO_LAUNCHER_ROOTS_ENV]: '' }]) {
      const anchor = launcherAnchor(home, env)
      await expect(anchor.root()).rejects.toMatchObject({ code: 'ROOT_NOT_ANCHORED', remedies: [], detail: expect.stringContaining(`this Delo was not started by its launcher, which names the release roots it ships in ${DELO_LAUNCHER_ROOTS_ENV}`) })
      await expect(anchor.shipped()).rejects.toMatchObject({ code: 'ROOT_NOT_ANCHORED', detail: expect.stringContaining('start Delo with its launcher') })
    }
  })

  it('anchors nothing when the directory the launcher named does not read as its roots', async () => {
    store(shipped.bytes)
    await expect(launcherAnchor(home, { [DELO_LAUNCHER_ROOTS_ENV]: join(base, 'missing') }).root()).rejects.toMatchObject({
      code: 'ROOT_NOT_ANCHORED',
      detail: expect.stringContaining(`the release roots of the launcher that started this Delo, at ${join(base, 'missing')}, do not read`),
    })
  })
})
