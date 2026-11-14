import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { JsonStorageBackend, previousPath, quarantinePath, rotatePrevious, setAsideFile, writeSetAside } from '../src/index.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-json-recoverable-'))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

const descriptor = { name: 'shape', version: 1, tables: ['t'], hasGlobal: true, recoverable: true }

describe('recoverable single unit', () => {
  it('keeps the previous good file before each write', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'a', 1)
    await expect(readFile(join(root, 'shape.json.previous'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const afterFirst = await readFile(join(root, 'shape.json'), 'utf8')
    await unit.putRecord('t', 'b', 2)
    expect(await readFile(join(root, 'shape.json.previous'), 'utf8')).toBe(afterFirst)
    if (process.platform !== 'win32') expect((await stat(join(root, 'shape.json.previous'))).mode & 0o777).toBe(0o600)
    await backend.close()
  })

  it('keeps no previous file unless the unit is recoverable', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ ...descriptor, recoverable: false })
    await unit.putRecord('t', 'a', 1)
    await unit.putRecord('t', 'b', 2)
    expect(await readdir(root)).toEqual(['shape.json'])
    await backend.close()
  })

  it('sets an unparsable file aside, opens empty and never overwrites an earlier quarantine', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), 'not json', 'utf8')
    const first = await new JsonStorageBackend(root).kv.open(descriptor)
    expect(first.quarantined).toHaveLength(1)
    expect(await readFile(first.quarantined![0]!, 'utf8')).toBe('not json')
    expect(await first.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await first.close()

    await writeFile(join(root, 'shape.json'), '{', 'utf8')
    const second = await new JsonStorageBackend(root).kv.open(descriptor)
    expect(second.quarantined![0]).not.toBe(first.quarantined![0])
    expect(await readFile(first.quarantined![0]!, 'utf8')).toBe('not json')
    expect(await readFile(second.quarantined![0]!, 'utf8')).toBe('{')
    await second.close()
  })

  it('rejects an unreadable file when the unit is not recoverable', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), 'not json', 'utf8')
    await expect(new JsonStorageBackend(root).kv.open({ ...descriptor, recoverable: false }))
      .rejects.toMatchObject({ code: 'malformed-medium' })
  })

  it('does not set aside a file of an unaccepted version', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), JSON.stringify({ unit: { name: 'shape', version: 9 }, global: null, tables: {} }), 'utf8')
    await expect(new JsonStorageBackend(root).kv.open(descriptor)).rejects.toMatchObject({ code: 'version-mismatch' })
    expect(await readdir(root)).toEqual(['shape.json'])
  })

  it('sets a finding aside and keeps the damaged file out of the backup until the next write lands', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'good', 1)
    await unit.putRecord('t', 'bad', 2)
    const good = await readFile(join(root, 'shape.json.previous'), 'utf8')
    const location = await unit.setAside!({ why: 'bad' })
    expect(JSON.parse(await readFile(location, 'utf8'))).toEqual({ why: 'bad' })
    await unit.deleteRecord('t', 'bad')
    expect(await readFile(join(root, 'shape.json.previous'), 'utf8')).toBe(good)
    await unit.putRecord('t', 'next', 3)
    const cleaned = JSON.parse(await readFile(join(root, 'shape.json.previous'), 'utf8')) as { tables: { t: object } }
    expect(Object.keys(cleaned.tables.t)).toEqual(['good'])
    await backend.close()
    await expect(unit.setAside!({})).rejects.toMatchObject({ code: 'closed' })
  })
})

describe('set-aside helpers', () => {
  it('name files by UTC time and add a suffix on a collision', async () => {
    const at = new Date('2026-11-14T10:15:30.123Z')
    expect(quarantinePath('/x/a.json', at, 0)).toBe('/x/a.json.quarantined-2026-11-14T10-15-30-123Z.json')
    expect(quarantinePath('/x/a.json', at, 2)).toBe('/x/a.json.quarantined-2026-11-14T10-15-30-123Z-2.json')
    expect(previousPath('/x/a.json')).toBe('/x/a.json.previous')
    const root = await freshRoot()
    const path = join(root, 'a.json')
    const first = await writeSetAside(path, 'one', at)
    const second = await writeSetAside(path, 'two', at)
    expect(second).toBe(quarantinePath(path, at, 1))
    expect(await readFile(first, 'utf8')).toBe('one')
    await writeFile(path, 'file', 'utf8')
    const moved = await setAsideFile(path, at)
    expect(moved).toBe(quarantinePath(path, at, 2))
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surface failures that are not a name collision', async () => {
    const root = await freshRoot()
    await expect(setAsideFile(join(root, 'missing.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(writeSetAside(join(root, 'no', 'such', 'dir.json'), 'x')).rejects.toMatchObject({ code: 'ENOENT' })
    await rotatePrevious(join(root, 'missing.json'))
    await mkdir(join(root, 'dir.json'))
    await expect(rotatePrevious(join(root, 'dir.json'))).rejects.toMatchObject({ code: 'EISDIR' })
    expect(await readdir(root)).toEqual(['dir.json'])
  })
})
