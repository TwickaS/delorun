/**
 * The provider settings the home process gives the CLI profile's sandbox: the canonical home, C1's read exemptions,
 * both channels' sockets, the Docker context's socket with its real path, and Docker Desktop's macOS sockets when
 * present; and the overlay that keeps the row's own plain settings and refuses expressions it cannot carry over.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { DOCKER_DESKTOP_SOCKETS, sandboxProtection, writeSandboxOverlay } from '../src/sandbox-protection.ts'

let base: string | undefined
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  if (base !== undefined) rmSync(base, { recursive: true, force: true })
  base = undefined
})

async function listen(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const server = createServer()
  servers.push(server)
  await new Promise<void>(resolve => server.listen(path, resolve))
}

function setUp(): { readonly home: string, readonly osHome: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dsp-')))
  const home = join(base, 'h')
  mkdirSync(join(home, 'run', 'default'), { recursive: true })
  return { home, osHome: join(base, 'u') }
}

describe('the CLI profile\'s sandbox protection', () => {
  it('names the canonical home, C1\'s read exemptions, both channel sockets and the Docker context\'s socket with its real path', async () => {
    const { home, osHome } = setUp()
    const engine = join(base ?? '', 'engine', 'docker.sock')
    await listen(engine)
    const link = join(base ?? '', 'docker.sock')
    symlinkSync(engine, link)
    const linkedHome = join(base ?? '', 'linked-home')
    symlinkSync(home, linkedHome)
    const protection = await sandboxProtection(linkedHome, 'default', { DOCKER_HOST: `unix://${link}`, DOCKER_CONFIG: join(base ?? '', 'no-config') }, osHome)
    expect(protection).toEqual({
      protectedHome: home,
      protectedHomeReadable: [...READ_EXEMPTIONS],
      deniedSockets: [join(home, 'run', 'default', 'update.sock'), join(home, 'run', 'default', 'supervisor.sock'), link, engine],
    })
  })

  it('adds Docker Desktop\'s macOS sockets that exist, each with its real path, and none that do not', async () => {
    const { home, osHome } = setUp()
    const [raw, plain, run] = DOCKER_DESKTOP_SOCKETS
    await listen(join(osHome, raw))
    await listen(join(base ?? '', 'vm', 'docker.sock'))
    mkdirSync(dirname(join(osHome, run)), { recursive: true })
    symlinkSync(join(base ?? '', 'vm', 'docker.sock'), join(osHome, run))
    const { deniedSockets } = await sandboxProtection(home, 'default', { DOCKER_CONFIG: join(base ?? '', 'no-config'), DOCKER_HOST: 'tcp://127.0.0.1:2375' }, osHome)
    expect(deniedSockets).toEqual([
      join(home, 'run', 'default', 'update.sock'),
      join(home, 'run', 'default', 'supervisor.sock'),
      join(osHome, raw),
      join(osHome, run),
      join(base ?? '', 'vm', 'docker.sock'),
    ])
    expect(deniedSockets).not.toContain(join(osHome, plain))
  })

  it('keeps the row\'s own plain settings in the overlay and refuses expressions it cannot carry over', async () => {
    const { home, osHome } = setUp()
    const protection = await sandboxProtection(home, 'default', { DOCKER_CONFIG: join(base ?? '', 'no-config'), DOCKER_HOST: 'tcp://127.0.0.1:2375' }, osHome)
    const patch = join(base ?? '', 'cordis.patch.yml')
    writeFileSync(patch, '- id: sandbox\n  config:\n    deniedSockets: [/elsewhere.sock]\n    extra: 1\n')
    const overlay = await writeSandboxOverlay(home, 'default', patch, protection)
    const [entry] = parse(readFileSync(overlay, 'utf8')) as [{ id: string, config: Record<string, unknown> }]
    expect(entry).toEqual({ id: 'sandbox', config: { extra: 1, protectedHome: home, protectedHomeReadable: [...READ_EXEMPTIONS], deniedSockets: ['/elsewhere.sock', ...protection.deniedSockets] } })
    writeFileSync(patch, '- id: sandbox\n  config:\n    protectedHome: !!js process.env.HOME\n')
    await expect(writeSandboxOverlay(home, 'default', patch, protection)).rejects.toThrow(/with expressions/)
  })
})
