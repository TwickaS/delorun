import { describe, expect, it } from 'vitest'
import { loopbackOrigin } from '../../src/studio-browser/index.ts'

describe('loopbackOrigin', () => {
  it.each([
    ['http://127.0.0.1:5173/some/path?q=1', 'http://127.0.0.1:5173'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['https://localhost/', 'https://localhost'],
    ['http://[::1]:8080/x', 'http://[::1]:8080'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
  ])('accepts %s', (url, origin) => {
    expect(loopbackOrigin(url)).toBe(origin)
  })

  it.each([
    'http://127.0.0.1.evil.example',
    'http://localhost@evil.example',
    'http://evil.example#@localhost',
    'http://localhost.evil.example',
    'file:///',
    'file:///etc/passwd',
    'http://192.0.2.2',
    'http://0.0.0.0:3000',
    'https://example.com',
    'ftp://127.0.0.1',
    'not a url',
    '',
  ])('refuses %s', url => {
    expect(() => loopbackOrigin(url)).toThrow(`studio-browser drives only a studio on this computer: ${url} is not a loopback address`)
  })
})
