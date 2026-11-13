import { describe, expect, it } from 'vitest'
import { planHarnessCarry, type HarnessFileSide } from '../src/harness-merge.ts'
import { storeEmptyVersion, storeFileVersion, storeFolder } from '../src/store.ts'
import { HARNESS_RECORD_SCHEMA, type ApprovedHarnessFile, type ChangeId, type ContentVersion, type HarnessRecord } from '../src/types.ts'
import { rejection, temporaryDirectory, writeFiles } from './support.ts'

const CHANGE = 'c0123456789' as ChangeId
const AT = '2026-11-11T00:00:00.000Z'
const EDITED = 'app/node_modules/@delo/cli/src/start.js'
const REMOVED = 'app/node_modules/@delo/cli/src/old.js'
const ADDED = 'app/node_modules/@delo/cli/src/added.js'

/**
 * A text side.
 * @param text - the text.
 * @returns the side, not executable.
 */
const text = (text: string): HarnessFileSide => ({ bytes: Buffer.from(text), executable: false })

/**
 * One record entry.
 * @param version - the approved content.
 * @param signed - the signed content, when the signed release has the file.
 * @returns the entry.
 */
const approved = (version: ContentVersion, signed?: ContentVersion): ApprovedHarnessFile => ({ version, ...signed === undefined ? {} : { signed }, change: CHANGE, approvedAt: AT })

/**
 * A record of runtime 1.0.0.
 * @param files - its files.
 * @returns the record.
 */
const record = (files: Readonly<Record<string, ApprovedHarnessFile>>): HarnessRecord => ({ schema: HARNESS_RECORD_SCHEMA, runtime: '1.0.0', files })

describe('planHarnessCarry', () => {
  it('plans one entry per approved file, in path order, from the stored sides and the target\'s signed files', async () => {
    const home = temporaryDirectory()
    const files = {
      [EDITED]: approved(await storeFileVersion(home, EDITED, Buffer.from('mine\n'), false), await storeFileVersion(home, EDITED, Buffer.from('base\n'), false)),
      [REMOVED]: approved(await storeEmptyVersion(home), await storeFileVersion(home, REMOVED, Buffer.from('old\n'), false)),
      [ADDED]: approved(await storeFileVersion(home, ADDED, Buffer.from('added\n'), true)),
    }
    const signed: Readonly<Record<string, HarnessFileSide>> = { [EDITED]: text('theirs\n'), [REMOVED]: text('old\n') }
    const asked: string[] = []

    const plan = await planHarnessCarry(home, record(files), async (path) => {
      asked.push(path)
      return Promise.resolve(signed[path])
    })

    expect(plan.from).toBe('1.0.0')
    expect(plan.entries.map(entry => [entry.file, entry.merge])).toEqual([
      [ADDED, { outcome: 'carried', carry: 'release-unchanged', result: { bytes: Buffer.from('added\n'), executable: true } }],
      [REMOVED, { outcome: 'carried', carry: 'release-unchanged', result: undefined }],
      [EDITED, { outcome: 'conflict', conflict: 'edits-overlap' }],
    ])
    expect(asked).toEqual([ADDED, REMOVED, EDITED])
    const edited = plan.entries[2]!
    expect(edited).toMatchObject({ approved: files[EDITED], base: text('base\n'), mine: text('mine\n'), theirs: text('theirs\n') })
    expect(plan.entries[0]).toMatchObject({ base: undefined, theirs: undefined })
  })

  it('plans nothing for a runtime without approved files', async () => {
    const home = temporaryDirectory()

    expect(await planHarnessCarry(home, record({}), async () => Promise.reject(new Error('not read')))).toEqual({ from: '1.0.0', entries: [] })
  })

  it('refuses a record whose version is not a one-file version of its path', async () => {
    const home = temporaryDirectory()
    const folder = temporaryDirectory()
    writeFiles(folder, { 'a.js': 'a\n', 'b.js': 'b\n' })
    const twoFiles = (await storeFolder(home, folder)).version
    const otherPath = await storeFileVersion(home, 'app/other.js', Buffer.from('x\n'), false)
    const none = async (): Promise<undefined> => Promise.resolve(undefined)

    await rejection(planHarnessCarry(home, record({ [EDITED]: approved(twoFiles) }), none), 'RECORD_UNREADABLE')
    await rejection(planHarnessCarry(home, record({ [EDITED]: approved(otherPath) }), none), 'RECORD_UNREADABLE')
  })

  it('refuses a record whose version the store does not hold', async () => {
    const home = temporaryDirectory()

    await rejection(planHarnessCarry(home, record({ [EDITED]: approved('f'.repeat(64) as ContentVersion) }), async () => Promise.resolve(undefined)), 'STORE_CORRUPT')
  })
})
