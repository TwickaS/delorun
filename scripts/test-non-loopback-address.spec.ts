import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { probeIpv6Loopback, probeNonLoopbackIpv4, probeZonedLoopback } from './test-non-loopback-address.ts'

const binding = vi.hoisted(() => ({ refusal: undefined as Error | undefined }))

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: vi.fn(),
}))

// The regression concerns OS interface metadata, not the test host's IPv6 availability.
vi.mock('node:http', () => ({
  createServer: () => {
    let reject: (error: Error) => void
    return {
      once(_event: string, listener: (error: Error) => void) { reject = listener },
      listen(_options: { host: string; port: number }, ready: () => void) {
        if (binding.refusal) reject(binding.refusal)
        else ready()
      },
      close(closed: () => void) { closed() },
    }
  },
}))

beforeEach(() => {
  binding.refusal = undefined
  vi.mocked(networkInterfaces).mockReturnValue({
    'Loopback Pseudo-Interface 1': [{
      address: '::1',
      netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      family: 'IPv6',
      mac: '00:00:00:00:00:00',
      internal: true,
      scopeid: 0,
      cidr: '::1/128',
    }],
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('returns a valid scoped literal when the interface display name contains spaces', async () => {
  const host = await probeZonedLoopback()
  expect(isIP(host ?? '')).toBe(6)
  expect(host).toContain('%')
})

it('skips a scoped loopback whose listener refuses the bind', async () => {
  binding.refusal = new Error('address unavailable')
  vi.spyOn(console, 'info').mockImplementation(() => {})
  expect(await probeZonedLoopback()).toBeUndefined()
})

it('says IPv6 loopback is unusable when the host cannot listen on ::1', async () => {
  binding.refusal = new Error('listen EADDRNOTAVAIL: address not available ::1')
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  expect(await probeIpv6Loopback()).toBeUndefined()
  expect(info).toHaveBeenCalledWith(expect.stringContaining('refused ::1: listen EADDRNOTAVAIL'))
})

it('leaves link-local IPv4 out of the non-loopback candidates', async () => {
  const entry = (address: string) => ({ address, netmask: '255.255.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/16` })
  vi.mocked(networkInterfaces).mockReturnValue({ eth0: [entry('169.254.83.107'), entry('192.168.1.20')] })
  expect(await probeNonLoopbackIpv4()).toBe('192.168.1.20')
  vi.mocked(networkInterfaces).mockReturnValue({ eth0: [entry('169.254.83.107')] })
  vi.spyOn(console, 'info').mockImplementation(() => {})
  expect(await probeNonLoopbackIpv4()).toBeUndefined()
})
