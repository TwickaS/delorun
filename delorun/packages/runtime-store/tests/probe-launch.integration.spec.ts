/**
 * Review probes (not part of the package): which bytes the start check covers — the binary, the entry, the stored
 * manifest, the stored file list, the release-log bundle — and refusals for symbolic links in the store.
 */
import { existsSync, lstatSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SUPPORTED } from '../src/index.ts'
import { fixtureHome, makeWritable, PLATFORM, version, type FixtureHome } from './support.ts'

const V1 = version('0.1.0')
const V2 = version('0.2.0')

let fixture: FixtureHome

beforeEach(async () => {
  fixture = fixtureHome()
  await fixture.install(V1)
  await fixture.install(V2)
  await fixture.store.switchTo(V1, V2)
})

afterEach(() => {
  fixture.remove()
})

function runtimes(): string {
  return join(fixture.home, 'runtimes')
}

function launch() {
  return fixture.store.prepareLaunch({ launcher: SUPPORTED, root: fixture.root, mode: 'warn', fullCheckDays: 7, profile: 'default', args: ['status'] })
}

/** Flip one byte of a file, as a tamper with the person's own access would. */
function flipByte(path: string): void {
  makeWritable(path)
  const bytes = readFileSync(path)
  bytes[0] = bytes[0]! ^ 0x01
  writeFileSync(path, bytes)
}

describe('probe: start-check byte coverage', () => {
  it('stops on one changed byte of the node binary', async () => {
    flipByte(join(runtimes(), V2, 'node/bin/node'))
    await expect(launch()).rejects.toMatchObject({ code: 'RUNTIME_CHANGED', name: 'RuntimeStoreError' })
  })

  it('stops on one changed byte of the stored file list', async () => {
    flipByte(join(runtimes(), `delorun-${V2}-${PLATFORM}.files.json`))
    await expect(launch()).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
  })

  it('stops on one changed byte of the stored manifest', async () => {
    flipByte(join(runtimes(), `delorun-${V2}.manifest.json`))
    await expect(launch()).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
  })

  it('launches with a changed release-log bundle byte (the store never reads the bundle; C18 checks it at install)', async () => {
    const bundle = join(runtimes(), `delorun-${V2}.manifest.log.json`)
    expect(existsSync(bundle)).toBe(true)
    flipByte(bundle)
    await expect(launch()).resolves.toMatchObject({ version: V2 })
  })

  it('launches with an extra empty directory under the installation (only files are listed)', async () => {
    makeWritable(join(runtimes(), V2))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(runtimes(), V2, 'app/planted'), { recursive: true })
    await expect(launch()).resolves.toMatchObject({ version: V2 })
  })

  it('fails closed when a stored release file is a symbolic link (readStoredRelease follows it, verification refuses)', async () => {
    const filesPath = join(runtimes(), `delorun-${V2}-${PLATFORM}.files.json`)
    const victim = join(runtimes(), 'delorun-attacker.json')
    makeWritable(runtimes())
    writeFileSync(victim, '{"signed":{"schema":"delorun.release-files/1"}}\n', { mode: 0o644 })
    renameSync(filesPath, `${filesPath}.orig`)
    symlinkSync(victim, filesPath)
    await expect(launch()).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
    expect(lstatSync(filesPath).isSymbolicLink()).toBe(true)
  })

  it('fails closed when store.json is a symbolic link', async () => {
    makeWritable(runtimes())
    renameSync(join(runtimes(), 'store.json'), join(runtimes(), 'store.json.orig'))
    symlinkSync(join(runtimes(), 'store.json.orig'), join(runtimes(), 'store.json'))
    await expect(launch()).rejects.toMatchObject({ code: 'NO_ACTIVE_RUNTIME' })
  })

  it('refuses with NO_ACTIVE_RUNTIME when the version directory is a symbolic link (isInstalled reads the link, not its target)', async () => {
    makeWritable(runtimes())
    renameSync(join(runtimes(), V2), join(runtimes(), `${V2}.orig`))
    symlinkSync(join(runtimes(), `${V2}.orig`), join(runtimes(), V2))
    await expect(launch()).rejects.toMatchObject({ code: 'NO_ACTIVE_RUNTIME' })
  })
})
