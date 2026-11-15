/**
 * The abstract Unix socket check of a wrap that shares the host's network: the parser on recorded `/proc/net/unix`
 * text, and `confine()` on the bwrap, Landlock and operator-runner paths.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { abstractListeners, abstractSocketRefusal } from '../src/abstract-sockets.ts'

const HEADER = 'Num       RefCount Protocol Flags    Type St Inode Path\n'

/** A desktop session's table: the X server and the session bus listen, a pipe socket pair and file sockets are present. */
const LISTENING = HEADER
  + '0000000000000000: 00000002 00000000 00010000 0001 01 20551 @/tmp/.X11-unix/X0\n'
  + '0000000000000000: 00000002 00000000 00010000 0001 01 20552 /tmp/.X11-unix/X0\n'
  + '0000000000000000: 00000002 00000000 00010000 0001 01 21001 @/tmp/dbus-AbCdEf12 with space\n'
  + '0000000000000000: 00000002 00000000 00010000 0005 01 21002 @/tmp/.ICE-unix/1234\n'
  + '0000000000000000: 00000003 00000000 00000000 0001 03 30001 @/tmp/.X11-unix/X0\n'
  + '0000000000000000: 00000002 00000000 00000000 0001 03 30002\n'

/** Only connected stream sockets, as the clients of a listener leave them. */
const CLIENTS_ONLY = HEADER
  + '0000000000000000: 00000003 00000000 00000000 0001 03 8404570 @f6da25b8ac6bef03/bus/systemctl/\n'
  + '0000000000000000: 00000003 00000000 00000000 0001 03 8210684 @9d11c816a64e2b2b/bus/systemd/bus-system\n'
  + '0000000000000000: 00000002 00000000 00000000 0001 01 30003 /run/user/1000/bus\n'

const DATAGRAM = `${HEADER}0000000000000000: 00000002 00000000 00000000 0002 01 41000 @/org/kernel/udev/monitor\n`

describe('abstractListeners', () => {
  it('lists a listening abstract name, a seqpacket listener and a name with spaces, once each, and nothing else', () => {
    expect(abstractListeners(LISTENING)).toEqual(['@/tmp/.ICE-unix/1234', '@/tmp/.X11-unix/X0', '@/tmp/dbus-AbCdEf12 with space'])
  })

  it('does not count a connected client socket that carries a listener\'s name', () => {
    expect(abstractListeners(CLIENTS_ONLY)).toEqual([])
  })

  it('counts a bound datagram socket, which receives from any sender that knows its name', () => {
    expect(abstractListeners(DATAGRAM)).toEqual(['@/org/kernel/udev/monitor'])
  })

  it('reads an empty table and unreadable lines as no listener', () => {
    expect(abstractListeners('')).toEqual([])
    expect(abstractListeners(`${HEADER}garbage\n`)).toEqual([])
  })

  it('names the sockets and every way out in the refusal, and counts names beyond the first five', () => {
    const names = ['@a', '@b', '@c', '@d', '@e', '@f', '@g']
    const text = abstractSocketRefusal(names)
    expect(text).toContain('7 abstract Unix sockets are listening ("@a", "@b", "@c", "@d", "@e" and 2 more)')
    expect(text).toContain('allowlist or to off')
    expect(text).toContain('Landlock abstract-socket scope')
    expect(text).toContain('accept the risk in Settings, Network')
    expect(text).toContain('when a command starts')
    expect(abstractSocketRefusal(['@x'])).toContain('1 abstract Unix socket is listening ("@x")')
  })
})

const OPEN: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/' }
const ACCEPTED: SandboxPolicy = { ...OPEN, network: { mode: 'host', abstractSockets: 'accepted' } }

async function provider(config: Config, internals: LocalSandboxProvider['internals']): Promise<LocalSandboxProvider> {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, config)
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { vsockOffered: () => false, ...internals }
  return sandbox
}

const bwrap = (read: () => string): LocalSandboxProvider['internals'] => ({ chain: ['bwrap'], readUnixSockets: read })
const landlock = (read: () => string): LocalSandboxProvider['internals'] => ({ chain: ['landlock'], landlockLauncher: '/nonexistent/landlock-run', readUnixSockets: read })
const operator = (read: () => string): LocalSandboxProvider['internals'] => ({ platform: 'linux', readUnixSockets: read })
const operatorConfig: Config = { runnerCommand: ['my-runner'], runnerFailureSignatures: ['my-runner: '] }

const runners: readonly (readonly [string, Config, (read: () => string) => LocalSandboxProvider['internals']])[] = [
  ['bwrap', {}, bwrap],
  ['landlock', {}, landlock],
  ['an operator runner', operatorConfig, operator],
]

describe.each(runners)('confine() on the host\'s network under %s', (_name, config, internals) => {
  it('refuses while an abstract socket listens, and names it', async () => {
    const sandbox = await provider(config, internals(() => LISTENING))
    await expect(sandbox.confine(['true'], OPEN)).rejects.toMatchObject({
      code: 'SANDBOX_UNSUPPORTED_POLICY',
      message: expect.stringContaining('@/tmp/.X11-unix/X0') as string,
    })
  })

  it('refuses when /proc/net/unix cannot be read', async () => {
    const sandbox = await provider(config, internals(() => { throw new Error('EACCES: permission denied') }))
    await expect(sandbox.confine(['true'], OPEN)).rejects.toMatchObject({
      code: 'SANDBOX_UNSUPPORTED_POLICY',
      message: expect.stringContaining('cannot read /proc/net/unix') as string,
    })
  })

  it('runs when only connected client sockets exist, and when none exist, with full enforcement', async () => {
    for (const text of [CLIENTS_ONLY, '']) {
      const sandbox = await provider(config, internals(() => text))
      expect((await sandbox.confine(['true'], OPEN)).enforcement).not.toBe('partial')
    }
  })

  it('runs with the risk accepted, reports partial enforcement, and does not check again when nothing listens', async () => {
    const sandbox = await provider(config, internals(() => LISTENING))
    const confined = await sandbox.confine(['true'], ACCEPTED)
    expect(confined.enforcement).toBe('partial')
    expect(confined.argv).not.toContain('--unshare-net')
    const quiet = await provider(config, internals(() => ''))
    expect((await quiet.confine(['true'], ACCEPTED)).enforcement).not.toBe('partial')
  })

  it('runs with the risk accepted and an unreadable table, reporting partial enforcement', async () => {
    const sandbox = await provider(config, internals(() => { throw new Error('EACCES') }))
    expect((await sandbox.confine(['true'], ACCEPTED)).enforcement).toBe('partial')
  })

  it('does not read the table for an `off` or `proxy` wrap', async () => {
    if (_name !== 'bwrap' && _name !== 'an operator runner') return
    const sandbox = await provider(config, internals(() => { throw new Error('must not be read') }))
    for (const network of [{ mode: 'off' as const }, { mode: 'proxy' as const, socket: '/run/p.sock' }]) {
      const confined = await sandbox.confine(['true'], { ...OPEN, network })
      expect(confined.argv).toContain('--unshare-net')
    }
  })
})

describe('the accepted-risk warning', () => {
  it('is logged once for an unchanged finding and again when the sockets change', async () => {
    let text = LISTENING
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(LocalSandboxProvider, {})
    const sandbox = ctx.sandbox as LocalSandboxProvider
    sandbox.internals = { vsockOffered: () => false, ...bwrap(() => text) }
    await sandbox.confine(['true'], ACCEPTED)
    await sandbox.confine(['true'], ACCEPTED)
    text = DATAGRAM
    await sandbox.confine(['true'], ACCEPTED)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('@/tmp/.X11-unix/X0'))
  })
})
