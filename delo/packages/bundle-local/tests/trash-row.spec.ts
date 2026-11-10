/**
 * The shipped composition mounts contract C8's trash over the home's own
 * stores: a Delo CLI profile composes the `delo-trash` row with the trash
 * root, the session root, the storage root and the home itself, each under
 * the harness home, which C1 sets to the Delo home. The parity form leaves the
 * row disabled, so recorded scenarios mount nothing of it. No row reads the
 * workspaces `delorun import` publishes under `archive/`: the studio does not
 * open imported chats yet, and those chats stay out of every model request.
 */
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { parityPatches } from '../src/profile.ts'
import { createTestHome, DELO_PROFILE, type TestHome } from './profiles.ts'

let home: TestHome

beforeAll(() => { home = createTestHome() })
afterAll(() => {
  vi.unstubAllEnvs()
  home.remove()
})

describe('the shipped composition\'s trash row', () => {
  it('mounts the trash over the home\'s trash, sessions and storages, and the parity form disables it', () => {
    vi.stubEnv('DSH_HOME', home.dir)
    const row = home.rows(DELO_PROFILE).find(entry => entry.id === 'delo-trash')

    expect(row?.name).toBe('@delo/plugin-trash')
    expect(row?.disabled).toBeUndefined()
    expect(interpolate({ dshHomePath }, row?.config)).toEqual({
      trashRoot: join(home.dir, 'trash'),
      sessionsRoot: join(home.dir, 'sessions'),
      storagesRoot: join(home.dir, 'storages'),
      attachmentsRoot: join(home.dir, 'attachments', 'v1'),
      logsHome: home.dir,
    })
    const [parity] = parityPatches([{ insert: [{ id: 'delo-trash', name: '@delo/plugin-trash' }] }])
    expect(parity).toEqual({ insert: [{ id: 'delo-trash', name: '@delo/plugin-trash', disabled: true }] })
  })
})

describe('the workspaces an import publishes', () => {
  it('are read by no row of the shipped composition', () => {
    const composed = JSON.stringify(home.rows(DELO_PROFILE))

    expect(composed).toContain("dshHomePath('trash')")
    expect(composed).not.toMatch(/['"/]archive['"/]/)
  })
})
