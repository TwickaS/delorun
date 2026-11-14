/**
 * What the studio's state reads of the changes waiting for review: the plugins under Changes and the agent's plugin
 * requests, from the records alone, writing nothing.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { recordedChanges, writeApproved, writeChangeLog, type ContentVersion } from '../src/index.ts'

it('names each plugin under Changes and the agent\'s requests from the records, and writes nothing', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-changes-state-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const home = join(root, '.delorun')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"dsh-profile-default","private":true}\n')
  const ctx = { home, profile: 'default', profileDir }
  expect(await recordedChanges(ctx)).toEqual({ folders: [], requests: [] })
  const at = '2026-11-10T10:00:00.000Z'
  await writeApproved(profileDir, { schema: 'delorun.changes-approved/1', plugins: { edited: { source: '/work/edited', version: 'a'.repeat(64) as ContentVersion, approvedAt: at } } })
  const request = { id: 'c0000000002' as never, kind: 'plugin-install' as const, state: 'pending' as const, subject: { spec: 'left-pad@1.3.0', plugin: 'left-pad' }, summary: 'Install left-pad', createdAt: at }
  await writeChangeLog(home, 'default', {
    schema: 'delorun.changes-log/1',
    entries: [
      { id: 'c0000000001' as never, kind: 'plugin-install', state: 'pending', subject: { plugin: 'added', source: '/work/added' }, summary: 'Install added', createdAt: at },
      request,
      { ...request, id: 'c0000000003' as never, state: 'discarded', decidedAt: at, decidedFrom: 'terminal' },
    ],
  })
  const files = readdirSync(home, { recursive: true }).sort()
  expect(await recordedChanges(ctx)).toEqual({
    folders: [{ plugin: 'added', source: '/work/added', kind: 'plugin-install' }, { plugin: 'edited', source: '/work/edited', kind: 'plugin-edit' }],
    requests: [request],
  })
  expect(readdirSync(home, { recursive: true }).sort()).toEqual(files)
})
