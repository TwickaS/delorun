/** The profile's history against a real git, in a temporary profile directory. */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HISTORY_DIR, HistoryUnavailableError, MAX_LIST, ProfileHistory } from '../src/history.ts'
import type { ProfileVersionId } from '../src/types.ts'

const FILES = ['package.json', 'cordis.patch.yml'] as const
let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'profile-history-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const history = (gitCommand = 'git') => new ProfileHistory(dir, FILES, gitCommand, 30_000)

it('starts with no versions, and saves the managed files as one only when they change', async () => {
  const profile = history()
  expect(await profile.list(10)).toEqual([])
  // A profile with none of the managed files starts the history with no version.
  expect(await profile.record('Nothing yet', { kind: 'person' })).toBeUndefined()
  expect(await profile.list(10)).toEqual([])
  writeFileSync(join(dir, 'package.json'), '{"name":"profile"}\n')
  writeFileSync(join(dir, 'notes.txt'), 'the person\'s own file\n')
  const first = await profile.record('Installed @acme/a', { kind: 'person' })
  expect(first).toMatch(/^[0-9a-f]{40}$/)
  expect(await profile.record('Nothing', { kind: 'person' })).toBeUndefined()
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: a\n  disabled: true\n')
  const second = await profile.record('Turned off include:a', { kind: 'agent', sessionId: 'session-1' })
  const versions = await profile.list(10)
  expect(versions.map(({ id, summary, changedBy }) => ({ id, summary, changedBy }))).toEqual([
    { id: second, summary: 'Turned off include:a', changedBy: { kind: 'agent', sessionId: 'session-1' } },
    { id: first, summary: 'Installed @acme/a', changedBy: { kind: 'person' } },
  ])
  expect(Math.abs((versions[0]?.at ?? 0) - Date.now())).toBeLessThan(60_000)
  expect(await profile.list(1)).toHaveLength(1)
  // Only the managed files are tracked; the person's own files stay out of the history.
  expect((await profile.filesAt(first!)).get('cordis.patch.yml')).toBeUndefined()
  expect([...(await profile.filesAt(second!)).entries()]).toEqual([
    ['package.json', '{"name":"profile"}\n'],
    ['cordis.patch.yml', '- id: a\n  disabled: true\n'],
  ])
  expect(existsSync(join(dir, HISTORY_DIR, 'HEAD'))).toBe(true)
  expect(readFileSync(join(dir, HISTORY_DIR, 'info', 'exclude'), 'utf8')).toBe('/*\n!/package.json\n!/cordis.patch.yml\n')
})

it('saves a removed file\'s absence, and keeps a one-line summary', async () => {
  const profile = history()
  writeFileSync(join(dir, 'package.json'), '{}\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  await profile.record('Both', { kind: 'person' })
  rmSync(join(dir, 'cordis.patch.yml'))
  const removed = await profile.record('Removed\n  the   patch', { kind: 'outside' })
  expect((await profile.filesAt(removed!)).get('cordis.patch.yml')).toBeUndefined()
  expect((await profile.list(1))[0]).toMatchObject({ summary: 'Removed the patch', changedBy: { kind: 'outside' } })
})

it('names a version committed by hand, with no trailer, as outside plugin management', async () => {
  const profile = history()
  writeFileSync(join(dir, 'package.json'), '{}\n')
  await profile.record('Start', { kind: 'person' })
  writeFileSync(join(dir, 'package.json'), '{"by":"hand"}\n')
  const env = { ...process.env, GIT_DIR: join(dir, HISTORY_DIR), GIT_WORK_TREE: dir, GIT_CONFIG_NOSYSTEM: '1' }
  execFileSync('git', ['-c', 'user.name=Hand', '-c', 'user.email=hand@example.invalid', 'commit', '--quiet', '-am', 'By hand'], { cwd: dir, env })
  expect((await profile.list(1))[0]).toMatchObject({ summary: 'By hand', changedBy: { kind: 'outside' } })
  // An agent trailer with no Session names no Agent's chat either.
  writeFileSync(join(dir, 'package.json'), '{"by":"hand","again":true}\n')
  execFileSync('git', ['-c', 'user.name=Hand', '-c', 'user.email=hand@example.invalid', 'commit', '--quiet', '-am', 'By hand again', '-m', 'Changed-by: agent'], { cwd: dir, env })
  expect((await profile.list(1))[0]).toMatchObject({ summary: 'By hand again', changedBy: { kind: 'outside' } })
})

it('refuses a version that is not one of the history\'s', async () => {
  const profile = history()
  writeFileSync(join(dir, 'package.json'), '{}\n')
  await profile.record('Start', { kind: 'person' })
  await expect(profile.filesAt(brandString<ProfileVersionId>('0'.repeat(40)))).rejects.toThrow(HistoryUnavailableError)
  await expect(profile.filesAt(brandString<ProfileVersionId>('HEAD'))).rejects.toThrow('no profile version HEAD')
})

it('reports git that cannot run, or that refuses, as an unavailable history', async () => {
  writeFileSync(join(dir, 'package.json'), '{}\n')
  await expect(history('dsh-no-such-git').record('Start', { kind: 'person' })).rejects.toThrow(HistoryUnavailableError)
  await expect(history('dsh-no-such-git').record('Start', { kind: 'person' })).rejects.toThrow('git could not run')
  // A git directory that is not a repository makes git itself refuse.
  const broken = history()
  writeFileSync(join(dir, 'package.json'), '{}\n')
  await broken.record('Start', { kind: 'person' })
  writeFileSync(join(dir, HISTORY_DIR, 'HEAD'), 'not a ref\n')
  await expect(broken.record('Again', { kind: 'person' })).rejects.toThrow(/git \w+ failed/)
})

it('reports a history directory it cannot make as an unavailable history', async () => {
  writeFileSync(join(dir, '.plugin-manager'), 'a file where the directory goes\n')
  writeFileSync(join(dir, 'package.json'), '{}\n')
  await expect(history().record('Start', { kind: 'person' })).rejects.toThrow(HistoryUnavailableError)
  await expect(history().record('Start', { kind: 'person' })).rejects.toThrow(/^the history directory cannot be made: /)
})

it('finds one version by its id, and none for an id it does not hold, and refuses a count git cannot read', async () => {
  const profile = history()
  expect(await profile.version(brandString<ProfileVersionId>('a'.repeat(40)))).toBeUndefined()
  writeFileSync(join(dir, 'package.json'), '{}\n')
  const first = await profile.record('Start', { kind: 'person' })
  writeFileSync(join(dir, 'package.json'), '{"next":true}\n')
  await profile.record('Next', { kind: 'agent', sessionId: 'session-2' })
  expect(await profile.version(first!)).toMatchObject({ id: first, summary: 'Start', changedBy: { kind: 'person' } })
  expect(await profile.version(brandString<ProfileVersionId>('0'.repeat(40)))).toBeUndefined()
  expect(await profile.version(brandString<ProfileVersionId>('HEAD'))).toBeUndefined()
  await expect(profile.list(2 ** 31)).rejects.toThrow('limit must be an integer from 1 to 2147483647')
  await expect(profile.list(0)).rejects.toThrow(RangeError)
  expect(await profile.list(MAX_LIST)).toHaveLength(2)
})
