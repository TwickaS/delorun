/**
 * The How Delorun runs service over a real profile directory, the profile's real write lock and a real listening port,
 * with only Tailscale, the reach service and the root check faked: a port another program holds is refused, concurrent
 * changes keep every one of them, and the files a change writes are private to the user.
 */
import { createServer, type Server } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DANGEROUS_PHRASE } from '@delorun/contract-setup-answers'
import { dangerousGrantPath, readDangerousGrant } from '@delorun/plugin-permission-defaults/store'
import { isPortFree } from '@delorun/reach'
import { fakeTailscale } from '../../reach/tests/fake-tailscale.ts'
import { RunSettings, systemDependencies } from '../src/run-settings.ts'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => { resolve() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A real home with one profile that setup has run for, and a service over it. */
function setup(runningPort?: number) {
  const home = mkdtempSync(join(tmpdir(), 'delorun-run-settings-it-'))
  roots.push(home)
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{}\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profileDir, 'setup-answers.json'), JSON.stringify({ version: 1, prompts: 'safer', background: true, profile: { name: null, port: null } }))
  const scope = { get: (name: string) => (name === 'profileContext' ? { name: 'default', dir: profileDir, home } : name === 'webServer' && runningPort !== undefined ? { port: runningPort } : undefined) }
  const service = new RunSettings({ ...systemDependencies(scope as never), tailscale: fakeTailscale('laptop.tail1234.ts.net').run, reach: () => undefined, runsAsRoot: () => false })
  return { service, home, profileDir, record: (): Record<string, unknown> => JSON.parse(readFileSync(join(profileDir, 'setup-answers.json'), 'utf8')) as Record<string, unknown> }
}

/**
 * Listen on a port the operating system picks.
 * @returns the port.
 */
async function hold(): Promise<number> {
  const server = createServer()
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

describe.skipIf(process.platform === 'win32')('the How Delorun runs service on a real profile', () => {
  it('refuses a port another program holds, and writes the port it is given when free', async () => {
    // Pins `isPortFree` against a real listener: a studio could not start on a port that is held.
    const w = setup()
    const busy = await hold()
    await expect(w.service.port(busy)).rejects.toMatchObject({ code: 'PORT_BUSY' })
    expect(readFileSync(join(w.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    const free = await hold()
    servers.pop()?.close()
    await expect.poll(() => isPortFree(free)).toBe(true)
    expect(await w.service.port(free)).toMatchObject({ port: free, restartNeeded: true })
    expect(w.record()).toMatchObject({ profile: { port: free } })
  })

  it('keeps every change when several arrive together', async () => {
    // Pins the profile's write lock: two unlocked read-modify-writes of the answers record would lose one.
    const w = setup()
    const port = await hold()
    servers.pop()?.close()
    await expect.poll(() => isPortFree(port)).toBe(true)
    await Promise.all([w.service.background(false), w.service.prompts('stock'), w.service.port(port)])
    expect(w.record()).toMatchObject({ prompts: 'stock', background: false })
    expect(w.record()['profile']).toEqual({ name: null, port })
  })

  it('writes the record and the grant file at mode 0600, and takes the grant away again with a safer answer', async () => {
    const w = setup()
    const begun = w.service.dangerousBegin()
    await w.service.dangerousConfirm({ nonce: begun.nonce, understood: true, phrase: DANGEROUS_PHRASE })
    expect((await readDangerousGrant(dangerousGrantPath(w.home))).kind).toBe('valid')
    expect(statSync(dangerousGrantPath(w.home)).mode & 0o777).toBe(0o600)
    expect(statSync(join(w.profileDir, 'setup-answers.json')).mode & 0o777).toBe(0o600)
    expect((await w.service.state()).dangerous).toBe('on')
    await w.service.prompts('safer')
    expect((await readDangerousGrant(dangerousGrantPath(w.home))).kind).toBe('absent')
    expect((await w.service.state()).dangerous).toBe('off')
  })
})
