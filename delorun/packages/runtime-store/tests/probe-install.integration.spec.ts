/**
 * Review probes (not part of the package): install failure windows.
 *
 * - A fault injected into the staging -> installation rename of a reinstall of `current` shows what a crash or a
 *   failing rename in that window leaves: `current` naming a version whose directory is gone (README, "Not
 *   covered", documents the crash form).
 * - A failed install of a new version shows the release files it already wrote stay behind until retention.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closureFiles, fixtureHome, makeWritable, releaseFiles, version, writeClosure, type FixtureHome } from './support.ts'

const faults = vi.hoisted(() => ({ failRenameTo: null as string | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const module = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...module,
    rename: async (from: string, to: string) => {
      if (faults.failRenameTo !== null && to === faults.failRenameTo && from.includes('staging')) {
        throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' })
      }
      return module.rename(from, to)
    },
  }
})

const V1 = version('0.1.0')
const V2 = version('0.2.0')

let fixture: FixtureHome

beforeEach(() => {
  fixture = fixtureHome()
})

afterEach(() => {
  faults.failRenameTo = null
  fixture.remove()
})

function runtimes(): string {
  return join(fixture.home, 'runtimes')
}

function fillFor(release: string) {
  return async (directory: string) => {
    writeClosure(directory, closureFiles(release))
    return releaseFiles(fixture.keys.targets, release, closureFiles(release))
  }
}

describe('probe: install failure windows', () => {
  it('a failing staging->installation rename during a reinstall of current leaves current naming a missing version', async () => {
    await fixture.install(V1)
    // tamper current so the update flow would reinstall it
    makeWritable(join(runtimes(), V1))
    writeFileSync(join(runtimes(), V1, 'app/package.json'), '{"name":"changed"}\n')
    faults.failRenameTo = join(runtimes(), V1)

    const failure = await fixture.store.install({ version: V1, root: fixture.root, fill: fillFor('0.1.0') }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((failure as Error).message).toBe('injected rename failure')
    // the old installation was already moved out and removed: current now names a version that is not installed
    expect(existsSync(join(runtimes(), V1))).toBe(false)
    const pointers = await fixture.store.pointers().then(
      (value) => value,
      (error: unknown) => error,
    )
    expect(pointers).toMatchObject({ code: 'NO_ACTIVE_RUNTIME', name: 'RuntimeStoreError' })
    expect((pointers as { remedies?: readonly string[] }).remedies).toEqual(['reinstall', 'rollback'])
    expect(readdirSync(join(fixture.home, 'staging'))).toEqual([])
  })

  it('a failed install of a new version leaves the release files it wrote under runtimes/ until retention', async () => {
    await fixture.install(V1)
    faults.failRenameTo = join(runtimes(), V2)
    await expect(fixture.store.install({ version: V2, root: fixture.root, fill: fillFor('0.2.0') })).rejects.toThrow('injected rename failure')
    expect(existsSync(join(runtimes(), V2))).toBe(false)
    expect(await fixture.store.pointers()).toEqual({ current: V1 })
    // the three release files are already in the store, orphaned
    expect(existsSync(join(runtimes(), `delorun-${V2}.manifest.json`))).toBe(true)
    expect(existsSync(join(runtimes(), `delorun-${V2}-linux-x64.files.json`))).toBe(true)
    expect(existsSync(join(runtimes(), `delorun-${V2}.manifest.log.json`))).toBe(true)
    // retention removes them (owner not kept) and the pointers stay
    await fixture.store.retain()
    expect(existsSync(join(runtimes(), `delorun-${V2}.manifest.json`))).toBe(false)
    expect(await fixture.store.pointers()).toEqual({ current: V1 })
  })
})
