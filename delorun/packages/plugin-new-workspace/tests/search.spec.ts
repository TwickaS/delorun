/**
 * The folder search: it finds folders by a case-insensitive part of their name, nearest first, within bounds of depth,
 * folder count, result count and time; it skips hidden, dependency and build folders and the Delorun and stock homes,
 * and never follows a symbolic link out of the roots.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { searchFolders, SKIPPED_NAMES, type SearchDeps } from '../src/search.ts'
import { MAX_SEARCH_RESULTS, SearchAnswer } from '../src/wire.ts'

let scratch = ''
let person = ''
let delorunHome = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-new-workspace-search-'))
  person = join(scratch, 'a', 'b', 'person')
  delorunHome = join(scratch, 'delorun')
  for (const directory of [person, delorunHome]) await mkdir(directory, { recursive: true })
  vi.stubEnv('HOME', person)
  vi.stubEnv('DELORUN_HOME', delorunHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

/** The search's dependencies over the home directory, with generous bounds. */
function deps(extra: Partial<SearchDeps> = {}): SearchDeps {
  return { roots: ['~'], depth: 4, folders: 20_000, timeMs: 2_000, env: process.env, warn: vi.fn(), ...extra }
}

/** Make folders under the home directory. */
async function folders(...paths: readonly string[]): Promise<void> {
  for (const path of paths) await mkdir(join(person, path), { recursive: true })
}

/** The names a search found. */
async function found(query: string, extra: Partial<SearchDeps> = {}): Promise<readonly string[]> {
  return (await searchFolders(query, deps(extra))).results.map(each => each.name)
}

describe('finding folders by name', () => {
  it('matches a part of the name without case, nearest first, and answers the folder\'s path', async () => {
    await folders('deep/er/ALPHA-three', 'work/Alpha-two', 'alpha-one', 'unrelated')
    const answer = SearchAnswer.parse(await searchFolders('alpha', deps()))
    expect(answer.results.map(each => each.name)).toEqual(['alpha-one', 'Alpha-two', 'ALPHA-three'])
    expect(answer.results[1]).toEqual({ path: join(person, 'work', 'Alpha-two'), name: 'Alpha-two' })
    expect(answer.stopped).toBe('complete')
  })

  it('finds nothing, having walked everything, when no name matches', async () => {
    await folders('one/two')
    expect(await searchFolders('zzz', deps())).toEqual({ results: [], stopped: 'complete' })
  })

  it('does not match files', async () => {
    await writeFile(join(person, 'alpha.txt'), '')
    expect(await found('alpha')).toEqual([])
  })

  it('searches every configured root', async () => {
    const other = join(scratch, 'other-root')
    await mkdir(join(other, 'alpha-there'), { recursive: true })
    await folders('alpha-here')
    expect([...await found('alpha', { roots: ['~', other] })].sort()).toEqual(['alpha-here', 'alpha-there'])
  })

  it('yields nothing from a root that does not exist', async () => {
    expect(await searchFolders('a', deps({ roots: [join(scratch, 'nope')] }))).toEqual({ results: [], stopped: 'complete' })
  })
})

describe('what a search never enters', () => {
  it('skips hidden folders and does not look inside them', async () => {
    await folders('.hidden/alpha-inside', '.alpha', 'alpha-visible')
    expect(await found('alpha')).toEqual(['alpha-visible'])
  })

  it.each([...SKIPPED_NAMES])('skips a folder named %s and what it holds', async (skipped) => {
    await folders(`${skipped}/alpha-inside`, 'alpha-visible')
    expect(await found('alpha')).toEqual(['alpha-visible'])
    expect(await found(skipped)).toEqual([])
  })

  it('skips the Delorun home when it is inside a root, and what it holds', async () => {
    vi.stubEnv('DELORUN_HOME', join(person, 'alpha-delorun'))
    await folders('alpha-delorun/alpha-inside', 'alpha-visible')
    expect(await found('alpha')).toEqual(['alpha-visible'])
  })

  it('skips the stock home, ~/.dsh, and what it holds', async () => {
    await folders('.dsh/alpha-inside', 'alpha-visible')
    expect(await found('alpha')).toEqual(['alpha-visible'])
  })

  it('still searches, with a warning, when the Delorun home cannot be resolved', async () => {
    vi.stubEnv('DELORUN_HOME', 'relative/home')
    await folders('alpha-visible')
    const warn = vi.fn()
    expect(await found('alpha', { warn })).toEqual(['alpha-visible'])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('never follows a symbolic link, neither as a match nor into what it points at', async () => {
    const outside = join(scratch, 'outside')
    await mkdir(join(outside, 'alpha-below'), { recursive: true })
    await symlink(outside, join(person, 'alpha-link'))
    await symlink(outside, join(person, 'plain-link'))
    await folders('alpha-real')
    expect(await found('alpha')).toEqual(['alpha-real'])
  })
})

describe('the bounds of a search', () => {
  it('looks only as deep below a root as it is told', async () => {
    await folders('alpha-1', 'x/alpha-2', 'x/y/alpha-3', 'x/y/z/alpha-4')
    expect(await found('alpha', { depth: 1 })).toEqual(['alpha-1'])
    expect(await found('alpha', { depth: 2 })).toEqual(['alpha-1', 'alpha-2'])
    expect(await found('alpha', { depth: 3 })).toEqual(['alpha-1', 'alpha-2', 'alpha-3'])
    expect(await found('alpha', { depth: 4 })).toEqual(['alpha-1', 'alpha-2', 'alpha-3', 'alpha-4'])
  })

  it('stops at the number of folders it may read, keeping what it found', async () => {
    await folders('alpha-top', 'x/y', 'x/z', 'w')
    const answer = await searchFolders('alpha', deps({ folders: 2 }))
    expect(answer).toEqual({ results: [{ path: join(person, 'alpha-top'), name: 'alpha-top' }], stopped: 'limit' })
  })

  it('stops at the most results it returns', async () => {
    await folders(...Array.from({ length: MAX_SEARCH_RESULTS + 5 }, (_, index) => `alpha-${String(index)}`))
    const answer = await searchFolders('alpha', deps())
    expect([answer.results.length, answer.stopped]).toEqual([MAX_SEARCH_RESULTS, 'limit'])
  })

  it('stops at the time bound, keeping what it found', async () => {
    await folders('alpha-top', 'x/alpha-deep')
    let calls = 0
    // The deadline is taken on the first call and the root's check is the second; every later call is past the deadline.
    const now = (): number => (++calls <= 2 ? 0 : 10_000)
    const answer = await searchFolders('alpha', deps({ now, timeMs: 100 }))
    expect(answer).toEqual({ results: [{ path: join(person, 'alpha-top'), name: 'alpha-top' }], stopped: 'time' })
  })
})
