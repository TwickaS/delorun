/**
 * The supervisor as the separate process the home process launches: the start token arrives on the inherited pipe,
 * never in the command line or the environment; the process listens under the Delorun home and logs to its C20 surface
 * without the token; it stops when the home process closes the pipe; and a new start's supervisor refuses the
 * previous start's token.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Writable } from 'node:stream'
import type { StartToken } from '@delorun/contract-home-layout'
import { resolveSurface } from '@delorun/logs'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeLaunch, supervisorSocketPath } from '../src/index.ts'
import { fixtureManifest, noDockerEnv, PROFILE, TIMING, send, tempHome, writeStartToken, type TempHome } from './support.ts'

const REPOSITORY = fileURLToPath(new URL('../../../../', import.meta.url))
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const START_MS = 30_000

let temp: TempHome | undefined
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  temp?.remove()
  temp = undefined
})

interface Launched {
  readonly child: ChildProcess
  readonly pipe: Writable
  readonly exited: Promise<number | null>
}

/**
 * Launch the supervisor's entry module the way the home process does, and wait for its socket.
 * @param home - the Delorun home.
 * @param token - this start's token.
 * @returns the child and its launch pipe.
 */
async function launch(home: string, token: StartToken): Promise<Launched> {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', MAIN], {
    cwd: REPOSITORY,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...noDockerEnv(home) },
  })
  children.push(child)
  const exited = new Promise<number | null>(resolve => child.once('exit', code => { resolve(code) }))
  const pipe = child.stdio[3] as Writable
  pipe.write(encodeLaunch({ v: 1, home, profile: PROFILE, startId: randomBytes(16).toString('hex'), token, manifest: fixtureManifest(), imagePull: 'none', seccompDirectory: join(home, 'seccomp'), logLevel: 'debug', timing: TIMING }))
  const socket = supervisorSocketPath(home, PROFILE)
  const deadline = Date.now() + START_MS
  while (!existsSync(socket)) {
    if (child.exitCode !== null) throw new Error(`the supervisor exited with ${String(child.exitCode)}`)
    if (Date.now() > deadline) throw new Error('the supervisor did not listen in time')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return { child, pipe, exited }
}

describe('the supervisor process', { timeout: 90_000 }, () => {
  it('takes its token from the launch pipe only, listens under the home and logs without the token', async () => {
    temp = await tempHome()
    const token = await writeStartToken(temp.home)
    const { child } = await launch(temp.home, token)
    expect(child.spawnargs.join(' ')).not.toContain(token)
    expect(Object.values(process.env).join('\n')).not.toContain(token)
    const socket = supervisorSocketPath(temp.home, PROFILE)
    expect(lstatSync(socket).mode & 0o777).toBe(0o600)
    expect(await send(socket, { v: 1, token, op: 'capabilities', args: { refresh: false } })).toMatchObject({ ok: true, docker: null, shapes: { s2: { available: false, reason: 'docker-unavailable' } } })
    expect(await send(socket, { v: 1, op: 'capabilities', args: { refresh: false } })).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
    const log = readFileSync(resolveSurface({ kind: 'supervisor', home: temp.home, profile: PROFILE }).file, 'utf8')
    expect(log).toContain('supervisor listening')
    const messages = log.split('\n').filter(line => line !== '').map(line => (JSON.parse(line) as { readonly msg: string }).msg)
    expect(messages).toContain('request {"op":"capabilities","outcome":"ok"}')
    expect(log.includes(token)).toBe(false)
  })

  it('stops and removes its socket when the home process closes the launch pipe', async () => {
    temp = await tempHome()
    const { pipe, exited } = await launch(temp.home, await writeStartToken(temp.home))
    pipe.end()
    expect(await exited).toBe(0)
    expect(existsSync(supervisorSocketPath(temp.home, PROFILE))).toBe(false)
  })

  it('exits, serving no token, when the home process closes the launch pipe right after the launch line', async () => {
    temp = await tempHome()
    const home = temp.home
    const token = await writeStartToken(home)
    const child = spawn(process.execPath, ['--import', 'tsx/esm', MAIN], { cwd: REPOSITORY, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, ...noDockerEnv(home) } })
    children.push(child)
    const exited = new Promise<number | null>(resolve => child.once('exit', code => { resolve(code) }))
    ;(child.stdio[3] as Writable).end(encodeLaunch({ v: 1, home, profile: PROFILE, startId: randomBytes(16).toString('hex'), token, manifest: fixtureManifest(), imagePull: 'none', seccompDirectory: join(home, 'seccomp'), logLevel: 'debug', timing: TIMING }))
    expect(await exited).toBe(0)
    const socket = supervisorSocketPath(home, PROFILE)
    expect(existsSync(socket)).toBe(false)
    await expect(send(socket, { v: 1, token, op: 'workspace.list' })).rejects.toMatchObject({ code: 'ENOENT' })
    const log = readFileSync(resolveSurface({ kind: 'supervisor', home, profile: PROFILE }).file, 'utf8')
    expect(log).toContain('the home process closed the launch pipe')
  })

  it('refuses the previous start\'s token once a new start has launched its supervisor', async () => {
    temp = await tempHome()
    const previous = await writeStartToken(temp.home)
    const first = await launch(temp.home, previous)
    first.pipe.end()
    await first.exited
    const current = await writeStartToken(temp.home)
    await launch(temp.home, current)
    const socket = join(temp.home, 'run', PROFILE, 'supervisor.sock')
    expect(await send(socket, { v: 1, token: previous, op: 'workspace.list' })).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
    expect(await send(socket, { v: 1, token: current, op: 'workspace.list' })).toMatchObject({ ok: false, error: 'DOCKER_UNAVAILABLE' })
  })
})
