/**
 * The journal of the stock-home import: a publication that fails partway
 * withdraws every file it placed and puts back every document it replaced, an
 * import a crash stopped is withdrawn by the next recovery, and a journal the
 * recovery cannot trust is kept rather than acted on. Each spec compares the
 * whole Delo home with its state before the import.
 */
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDshHomeImport, DshImportError, recoverDshImport, recoverStockImport, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL, type DshImportApplyOptions } from '../src/dsh-import/index.ts'
import { makeHomes, mark, plan, populate, PROJECT, read, registry, sha256, snapshot, type Homes } from './dsh-import-support.ts'

/** Every category taken. */
const ALL: DshImportApplyOptions = { include: { profiles: true, settings: true, instructions: true, skills: true, credentials: true } }

let homes: Homes

beforeEach(() => {
  homes = makeHomes()
})

afterEach(() => {
  homes.remove()
})

/**
 * Shape a merge: a Delo home with its own workspace list, credentials and import record, which the import replaces.
 */
function mergeFixture(): void {
  populate(homes)
  homes.writeTarget('storages/workspace.json', registry({ d1: { path: '/work/delo', sessionIds: [] } }))
  homes.writeTarget('.credentials.yaml', 'version: 1\nrefs:\n  OTHER: delo-value\n', 0o600)
  homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/imports.json`, '{"v":1,"imports":[]}\n', 0o600)
}

/**
 * The Delo home without the import's own directory, which a recovery leaves in place once it is empty of staging.
 * @returns the snapshot.
 */
function home(): ReturnType<typeof snapshot> {
  return snapshot(homes.target).filter(entry => !entry.path.startsWith('archive'))
}

describe('a stock-home import that stops partway', () => {
  it('withdraws every file it placed and puts back each document it replaced when a publication fails', async () => {
    mergeFixture()
    const before = snapshot(homes.target)
    const planned = await plan(homes)
    // The Delo home gains the last chat file before the import reaches it, so its link fails.
    let placed = 0
    const refusal = await applyDshHomeImport(planned, {
      ...ALL,
      onPublished: () => {
        placed += 1
        if (placed === 2) writeFileSync(join(homes.target, 'sessions/_no-cwd/s2/session.v4.jsonl.zstd'), 'appeared')
      },
    }).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(DshImportError)
    expect((refusal as DshImportError).code).toBe('DSH_IMPORT_TARGET_REFUSED')
    // Only the file that appeared, and the directories it keeps from being removed, differ from before.
    expect(snapshot(homes.target).filter(entry => !entry.path.startsWith('sessions'))).toEqual(before)
    expect(snapshot(homes.target).filter(entry => entry.digest !== 'directory').map(entry => entry.path).filter(path => path.startsWith('sessions'))).toEqual(['sessions/_no-cwd/s2/session.v4.jsonl.zstd'])
    expect(read(homes.target, 'storages/workspace.json')).toBe(registry({ d1: { path: '/work/delo', sessionIds: [] } }))
    expect(read(homes.target, '.credentials.yaml')).toBe('version: 1\nrefs:\n  OTHER: delo-value\n')
    expect(existsSync(join(homes.target, `sessions/${PROJECT}/s1/session.v4.jsonl.zstd`))).toBe(false)
    expect(readdirSync(join(homes.target, STOCK_IMPORT_DIRECTORY))).toEqual(['imports.json'])
  })

  // Four whole imports, each with its staged files synced, so the spec gets the time of four.
  it('is withdrawn by the next recovery when a crash stopped it after any publication, and the replaced documents come back', async () => {
    mergeFixture()
    const before = home()
    const planned = await plan(homes)
    // Every file the import places: the chats, the attachments, the joined list, each profile's manifest, patch layer and
    // pnpm settings, the settings layers, the instructions, the skill, the credentials and the record.
    const total = planned.chats.flatMap(chat => chat.files).length + planned.attachments.length + 1 + 3 * planned.profiles.length
      + planned.layers.length + 1 + planned.skills.flatMap(skill => skill.files).length + 1 + 1
    for (const stopAfter of [1, 4, total - 1, total]) {
      let placed = 0
      let stopped: () => void = () => undefined
      const crashed = new Promise<void>((resolve) => { stopped = resolve })
      // The import never continues past this point, as if its process had died.
      void applyDshHomeImport(await plan(homes), { ...ALL, stagingId: () => `crash-${String(stopAfter)}`, onPublished: () => {
        placed += 1
        if (placed < stopAfter) return
        stopped()
        return new Promise<void>(() => undefined)
      } })
      await crashed
      expect(existsSync(join(homes.target, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))).toBe(true)
      const recovered = await recoverDshImport(homes.target)
      expect(recovered.withdrawn).toHaveLength(stopAfter)
      expect(recovered.removed).toBe(0)
      expect(home()).toEqual(before)
      expect(read(homes.target, `${STOCK_IMPORT_DIRECTORY}/imports.json`)).toBe('{"v":1,"imports":[]}\n')
    }
    expect(planned.blockers).toEqual([])
  }, 60_000)

  it('removes a staging root a crash left after completion, and refuses an import while a journal waits', async () => {
    mark(homes)
    mkdirSync(join(homes.target, STOCK_IMPORT_DIRECTORY, 'staging-left'), { recursive: true })
    writeFileSync(join(homes.target, STOCK_IMPORT_DIRECTORY, 'staging-left', 'chat'), 'decoded chat content')
    writeFileSync(join(homes.target, STOCK_IMPORT_DIRECTORY, 'unrelated'), 'kept')
    const journal = JSON.stringify({ v: 1, staging: 'staging-gone', directories: ['x'], entries: [{ path: 'x/AGENTS.md', replace: false, sha256: sha256('notes') }] })
    writeFileSync(join(homes.target, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL), journal)
    homes.writeTarget('x/AGENTS.md', 'notes')
    const planned = await plan(homes)
    await expect(applyDshHomeImport(planned, { include: {} })).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED' })
    // A journal whose staging directory is gone cannot tell the files it placed from the person's own: it is kept.
    await expect(recoverDshImport(homes.target)).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED', message: expect.stringContaining('staging directory archive/stock-import/staging-gone is gone') as string })
    expect(read(homes.target, `${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`)).toBe(journal)
    expect(read(homes.target, 'x/AGENTS.md')).toBe('notes')
    rmSync(join(homes.target, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))
    expect(await recoverDshImport(homes.target)).toEqual({ withdrawn: [], kept: [], removed: 1 })
    expect(readdirSync(join(homes.target, STOCK_IMPORT_DIRECTORY))).toEqual(['unrelated'])
    expect(await recoverDshImport(join(homes.root, 'no-home'))).toEqual({ withdrawn: [], kept: [], removed: 0 })
  })

  it('keeps a journal it cannot trust and withdraws nothing', async () => {
    homes.writeTarget('AGENTS.md', 'the person\'s own notes')
    const journal = join(homes.target, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL)
    for (const text of ['{', JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, staging: '../../x', directories: [], entries: [] }), JSON.stringify({ v: 1, staging: 'staging-a', directories: [1], entries: [] }), JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: [{ path: 'AGENTS.md', sha256: sha256('x') }] }), JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: {} }),
      JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: [{ path: 'a/../AGENTS.md', replace: false, sha256: sha256('x') }] }),
      JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: [{ path: '/etc/passwd', replace: false, sha256: sha256('x') }] }),
      JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: [{ path: 'AGENTS.md', replace: false, sha256: sha256('x') }, { path: 'AGENTS.md', replace: true, sha256: sha256('x') }] }),
      JSON.stringify({ v: 1, staging: 'staging-a', directories: ['sessions'], entries: [{ path: 'AGENTS.md', replace: false, sha256: sha256('x') }] }),
      JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: [{ path: 'AGENTS.md', replace: false }] }),
      JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: [{ path: 'AGENTS.md', replace: false, sha256: 'not-a-digest' }] })]) {
      homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`, text)
      await expect(recoverDshImport(homes.target)).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED' })
      expect(read(homes.target, `${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`)).toBe(text)
    }
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`, JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: [{ path: '../outside', replace: false, sha256: sha256('x') }] }))
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/staging-a/files/x`, 'x')
    await expect(recoverDshImport(homes.target)).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED' })
    expect(existsSync(journal)).toBe(true)
    expect(read(homes.target, 'AGENTS.md')).toBe('the person\'s own notes')
  })

  it('withdraws only what the journal names that is still the staged file, and keeps a directory something else now uses', async () => {
    homes.writeTarget('AGENTS.md', 'the person\'s own notes')
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/staging-a/files/AGENTS.md`, 'staged notes')
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/staging-a/files/skills/x/SKILL.md`, 'staged skill')
    homes.writeTarget('skills/x/other.md', 'something else')
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/staging-a/files/settings.yaml`, 'staged settings')
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/staging-a/files/cordis.patch.yml`, 'staged patch')
    homes.writeTarget('cordis.patch.yml', 'the person\'s patch')
    // A replacement stopped between its temporary link and its rename, and one whose original was never linked aside.
    linkSync(join(homes.target, STOCK_IMPORT_DIRECTORY, 'staging-a/files/cordis.patch.yml'), join(homes.target, 'cordis.patch.yml.dsh-import-staging-a'))
    linkSync(join(homes.target, STOCK_IMPORT_DIRECTORY, 'staging-a/files/settings.yaml'), join(homes.target, 'settings.yaml'))
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`, JSON.stringify({ v: 1, staging: 'staging-a', directories: ['skills', 'skills/x', 'never'], entries: [{ path: 'AGENTS.md', replace: false, sha256: sha256('staged notes') }, { path: 'skills/x/SKILL.md', replace: true, sha256: sha256('staged skill') }, { path: 'never/missing', replace: false, sha256: sha256('x') }, { path: 'cordis.patch.yml', replace: true, sha256: sha256('staged patch') }, { path: 'settings.yaml', replace: true, sha256: sha256('staged settings') }] }))
    expect((await recoverDshImport(homes.target)).withdrawn).toEqual(['settings.yaml'])
    expect(read(homes.target, 'AGENTS.md')).toBe('the person\'s own notes')
    expect(read(homes.target, 'skills/x/other.md')).toBe('something else')
    expect(read(homes.target, 'cordis.patch.yml')).toBe('the person\'s patch')
    expect(existsSync(join(homes.target, 'cordis.patch.yml.dsh-import-staging-a'))).toBe(false)
    expect(existsSync(join(homes.target, 'settings.yaml'))).toBe(false)
  })

  it('refuses an import directory that is a link, before it reads a journal through it', async () => {
    mkdirSync(join(homes.target, 'archive'))
    symlinkSync(homes.outside, join(homes.target, STOCK_IMPORT_DIRECTORY))
    writeFileSync(join(homes.outside, STOCK_IMPORT_JOURNAL), '{')
    await expect(recoverDshImport(homes.target)).rejects.toMatchObject({ code: 'DSH_IMPORT_TARGET_REFUSED', subject: STOCK_IMPORT_DIRECTORY })
    expect(readdirSync(homes.outside)).toEqual([STOCK_IMPORT_JOURNAL])
  })

  it('refuses a staging root that cannot be created, and leaves no directory of its own behind', async () => {
    mark(homes)
    const planned = await plan(homes)
    homes.writeTarget('archive', 'a file')
    await expect(applyDshHomeImport(planned, { include: {} })).rejects.toMatchObject({ code: 'DSH_IMPORT_TARGET_REFUSED' })
    homes.remove()
    homes = makeHomes()
    mark(homes)
    const again = await plan(homes)
    await expect(applyDshHomeImport(again, { include: {}, stagingId: () => 'bad/name' })).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED' })
    expect(readdirSync(homes.target)).toEqual([])
    await expect(applyDshHomeImport({ ...again, target: join(homes.root, 'no-home') }, { include: {} })).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED' })
  })

  it('keeps a journal that is not a plain file, and reads nothing through a link at its path', async () => {
    homes.writeOutside('journal.json', JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: [] }))
    mkdirSync(join(homes.target, STOCK_IMPORT_DIRECTORY), { recursive: true })
    symlinkSync(join(homes.outside, 'journal.json'), join(homes.target, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))
    await expect(recoverDshImport(homes.target)).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED' })
    expect(readdirSync(homes.outside)).toEqual(['journal.json'])
  })
})

describe('the recovery before a profile starts', () => {
  it('withdraws an interrupted import, so the profile never starts over half of one', async () => {
    mark(homes)
    homes.write('sessions/_no-cwd/s1/session.v4.jsonl.zstd', 'chat')
    let stopped: () => void = () => undefined
    const crashed = new Promise<void>((resolve) => { stopped = resolve })
    void applyDshHomeImport(await plan(homes), { include: {}, onPublished: () => {
      stopped()
      return new Promise<void>(() => undefined)
    } })
    await crashed
    expect(existsSync(join(homes.target, 'sessions/_no-cwd/s1/session.v4.jsonl.zstd'))).toBe(true)
    await recoverStockImport(homes.target)
    expect(existsSync(join(homes.target, 'sessions/_no-cwd/s1'))).toBe(false)
    expect(existsSync(join(homes.target, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))).toBe(false)
  })

  it('refuses to let a profile start while a journal it cannot read waits, and says what to do', async () => {
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`, '{')
    await expect(recoverStockImport(homes.target)).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED', message: expect.stringContaining('Delo does not start while an interrupted import may be half in place') as string })
    rmSync(join(homes.target, 'archive'), { recursive: true })
    homes.writeTarget('archive', 'a file')
    await expect(recoverStockImport(homes.target)).rejects.toMatchObject({ code: 'DSH_IMPORT_TARGET_REFUSED' })
  })
})
