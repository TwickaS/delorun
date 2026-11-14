/**
 * The home process as the Docker supervisor's launcher (C19 start step 6, C9): the supervisor receives this start's
 * token on its launch pipe, never in its command line, accepts that token and refuses the previous start's, and
 * stops when the home process stops.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readStartTokenFile, startTokenFile } from '@delorun/home'
import { supervisorSocketPath } from '@delorun/supervisor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureManifest, noDockerEnv, send, TIMING } from '../../supervisor/tests/support.ts'
import type { SupervisorSetup } from '../src/index.ts'
import { FixtureStore, installFixture, PROFILE, REPOSITORY, startHome, tempHome, until, V1, type InProcessHome, type TempHome } from './support.ts'

const MAIN = fileURLToPath(new URL('../../supervisor/src/main.ts', import.meta.url))

let temp: TempHome | undefined
let running: InProcessHome | undefined
afterEach(async () => {
  await running?.process.shutdown(0)
  running?.exit()
  running = undefined
  vi.unstubAllEnvs()
  temp?.remove()
  temp = undefined
})

function setup(home: string): SupervisorSetup {
  return {
    command: { command: process.execPath, args: ['--import', 'tsx/esm', MAIN], cwd: REPOSITORY },
    manifest: fixtureManifest(), imagePull: 'none', seccompDirectory: join(home, 'seccomp'), logLevel: 'debug', timing: TIMING,
  }
}

describe('the supervisor the home process launches', { timeout: 90_000 }, () => {
  it('serves this start\'s token, refuses the previous start\'s and stops with the home process', async () => {
    temp = await tempHome()
    installFixture(temp.home, V1)
    await FixtureStore.seed(temp.home, V1)
    for (const [name, value] of Object.entries(noDockerEnv(temp.home))) vi.stubEnv(name, value)
    const socket = supervisorSocketPath(temp.home, PROFILE)
    running = await startHome(temp.home, { supervisor: setup(temp.home) })
    await until(() => existsSync(socket), 30_000, 'the supervisor socket')
    const first = await readStartTokenFile(startTokenFile(temp.home, PROFILE))
    expect(await send(socket, { v: 1, token: first, op: 'capabilities', args: { refresh: false } })).toMatchObject({ ok: true })
    await running.process.shutdown(0)
    running.exit()
    await until(() => !existsSync(socket), 30_000, 'the supervisor to stop')

    running = await startHome(temp.home, { supervisor: setup(temp.home) })
    await until(() => existsSync(socket), 30_000, 'the next supervisor socket')
    const second = await readStartTokenFile(startTokenFile(temp.home, PROFILE))
    expect(second).not.toBe(first)
    expect(await send(socket, { v: 1, token: first, op: 'capabilities', args: { refresh: false } })).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
    expect(await send(socket, { v: 1, token: second, op: 'capabilities', args: { refresh: false } })).toMatchObject({ ok: true })
  })
})
