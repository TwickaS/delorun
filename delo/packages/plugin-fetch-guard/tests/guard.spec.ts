/**
 * The refusal matrix, free of Cordis: loopback, link-local, RFC1918 private,
 * IPv6 unique-local, shared (carrier-grade NAT), multicast, reserved, the
 * unspecified address and anything unclassifiable are refused; a public-looking
 * address passes; the typed refusal names the host and the reason and no
 * resolved address. No network runs here: the classifier reads literals only.
 */
import { describe, expect, it } from 'vitest'
import { classifyAddress, FetchGuardRefusedError, refusalMessage, refusalOf } from '../src/guard.ts'

describe('the refusal matrix', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['169.254.0.1', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['10.0.0.5', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['192.168.0.0', 'private'],
    ['::ffff:10.0.0.5', 'private'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456:789a::1', 'unique-local'],
    // 100.64.0.0/10 is shared address space: a tailnet and its API live there.
    ['100.64.0.1', 'shared'],
    ['100.100.100.100', 'shared'],
    ['100.127.255.255', 'shared'],
    ['::ffff:100.64.0.1', 'shared'],
    // 224.0.0.0/4 and ff00::/8 are multicast.
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['ff02::1', 'multicast'],
    ['ff00::', 'multicast'],
    // 240.0.0.0/4 is reserved and holds the broadcast address.
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    // The unspecified address, in both spellings of each family.
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['::0.0.0.0', 'unspecified'],
    ['::ffff:0.0.0.0', 'unspecified'],
    // 64:ff9b::/96 is the well-known NAT64 prefix: the translator reaches the
    // IPv4 address the low half spells, so that address is what is classified.
    ['64:ff9b::10.0.0.5', 'private'],
    ['64:ff9b::a00:5', 'private'],
    ['64:ff9b::127.0.0.1', 'loopback'],
    ['64:ff9b::100.64.0.1', 'shared'],
    ['64:ff9b::255.255.255.255', 'reserved'],
    // 64:ff9b:1::/48 is the local-use NAT64 prefix, deployed as a /96.
    ['64:ff9b:1::a00:1', 'private'],
    ['64:ff9b:1:ab:cd::127.0.0.1', 'loopback'],
    // 6to4 tunnels to the IPv4 address after 2002::/16.
    ['2002:0a00:0001::', 'private'],
    ['2002:7f00:1::1', 'loopback'],
    ['2002:a9fe:a9fe::', 'link-local'],
    // Teredo, here through the documentation server 192.0.2.1, delivers to its client address, the inverted
    // low 32 bits, here a private and a loopback address.
    ['2001:0:c000:201:8000:63bf:f5ff:fffe', 'private'],
    ['2001::80ff:fffe', 'loopback'],
    // fec0::/10 is the deprecated site-local range; ::ffff:0:0:0/96 is IPv4-translated.
    ['fec0::1', 'private'],
    ['feff:ffff::1', 'private'],
    ['::ffff:0:192.0.2.10', 'reserved'],
    ['::ffff:0:a00:5', 'reserved'],
    ['not-an-address', 'unclassifiable'],
    ['1.2.3', 'unclassifiable'],
    ['300.1.1.1', 'unclassifiable'],
    ['127.0.0.01', 'unclassifiable'],
    ['1.2.3.4.5', 'unclassifiable'],
    [':::', 'unclassifiable'],
  ] as const)('refuses %s as %s', (address, code) => {
    expect(classifyAddress(address)).toBe(code)
  })

  it.each([
    ['192.0.2.10'],
    ['198.51.100.10'],
    ['203.0.113.10'],
    ['198.51.100.7'],
    ['172.15.0.1'],
    ['172.32.0.1'],
    ['192.169.0.1'],
    ['100.63.255.255'],
    ['100.128.0.0'],
    ['223.255.255.255'],
    ['2001:db8::10'],
    ['2001:db8::1'],
    ['::ffff:192.0.2.10'],
    // A NAT64 destination whose translator would reach a public address stays
    // reachable: that is how a v6-only network reaches the IPv4 web at all.
    ['64:ff9b::203.0.113.10'],
    ['64:ff9b:1::203.0.113.10'],
    ['2002:cb00:710a::1'],
    // A Teredo client at 203.0.113.10, stored inverted as 0x34ff8ef5.
    ['2001:0:c000:201:8000:63bf:34ff:8ef5'],
  ] as const)('allows the public-looking address %s', (address) => {
    expect(classifyAddress(address)).toBeUndefined()
  })

  it('refuses a hop whose first resolved address is refused and a hop with no address', () => {
    expect(refusalOf(['192.0.2.10', '10.0.0.9'])).toBe('private')
    expect(refusalOf(['10.0.0.9', '127.0.0.1'])).toBe('private')
    expect(refusalOf(['fe80::1', '127.0.0.1'])).toBe('link-local')
    expect(refusalOf(['192.0.2.10', '100.100.100.100'])).toBe('shared')
    expect(refusalOf(['192.0.2.10', '2001:db8::10'])).toBeUndefined()
    expect(refusalOf([])).toBe('unclassifiable')
  })
})

describe('the typed refusal', () => {
  it('names the host and the reason and no resolved address', () => {
    const message = refusalMessage('private', 'guard-private.test')
    expect(message).toBe('web fetch refused: the host "guard-private.test" is a private-network address, which web_fetch does not fetch')
    expect(message).not.toContain('10.')
  })

  it('carries the code and the host the refusal is about', () => {
    const error = new FetchGuardRefusedError('loopback', 'guard-rebind.test', refusalMessage('loopback', 'guard-rebind.test'))
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('FetchGuardRefusedError')
    expect(error.code).toBe('loopback')
    expect(error.host).toBe('guard-rebind.test')
    expect(error.message).toContain('a loopback address')
  })
})
