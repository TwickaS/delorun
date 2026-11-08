/**
 * The refusal matrix, free of Cordis: loopback, link-local, RFC1918 private,
 * IPv6 unique-local, the unspecified address and anything unclassifiable are
 * refused; a public-looking address passes; the typed refusal names the host
 * and the reason and no resolved address. No network runs here: the
 * classifier reads literals only.
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
    ['0.0.0.0', 'unspecified'],
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
    ['2001:db8::10'],
    ['2001:db8::1'],
    ['::ffff:192.0.2.10'],
  ] as const)('allows the public-looking address %s', (address) => {
    expect(classifyAddress(address)).toBeUndefined()
  })

  it('refuses a hop whose first resolved address is refused and a hop with no address', () => {
    expect(refusalOf(['192.0.2.10', '10.0.0.9'])).toBe('private')
    expect(refusalOf(['10.0.0.9', '127.0.0.1'])).toBe('private')
    expect(refusalOf(['fe80::1', '127.0.0.1'])).toBe('link-local')
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
