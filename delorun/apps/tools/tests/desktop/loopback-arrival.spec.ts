import { describe, expect, it } from 'vitest'
import { classifyArrival, cookieOf, curlConfig, parseCurlOutput, pickProbePort, PROBE_PORT_RANGE } from '../../src/desktop/loopback-arrival.ts'

const refused = 'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n{"error":{"code":"LOOPBACK_REQUIRED","message":"x needs you at your computer"}}'
const signIn = 'HTTP/1.1 303 See Other\r\nLocation: /\r\nSet-Cookie: dsh-auth-1=abc; Path=/; HttpOnly\r\nSet-Cookie: other=2; Path=/\r\n\r\n'

describe('the loopback-arrival probe', () => {
  it('reads curl.exe output with CRLF headers', () => {
    const answer = parseCurlOutput(refused)
    expect(answer.status).toBe(403)
    expect(answer.headers['content-type']).toEqual(['application/json'])
    expect(answer.body).toContain('LOOPBACK_REQUIRED')
    expect(parseCurlOutput('')).toEqual({ status: 0, headers: {}, body: '' })
  })

  it('classifies the guarded route: refused as not loopback, admitted as loopback, anything else as inconclusive', () => {
    expect(classifyArrival(parseCurlOutput(refused))).toBe('not-loopback')
    expect(classifyArrival({ status: 200, headers: {}, body: '{"on":false}' })).toBe('loopback')
    expect(classifyArrival({ status: 401, headers: {}, body: '' })).toBe('inconclusive')
    expect(classifyArrival({ status: 403, headers: {}, body: '{"error":{"code":"OTHER"}}' })).toBe('inconclusive')
    expect(classifyArrival({ status: 0, headers: {}, body: '' })).toBe('inconclusive')
  })

  it('takes the cookie only from a sign-in answer', () => {
    expect(cookieOf(parseCurlOutput(signIn))).toBe('dsh-auth-1=abc; other=2')
    expect(cookieOf(parseCurlOutput(refused))).toBeUndefined()
  })

  it('only uses ports of its own range, never the owner\'s studio ports', async () => {
    for (const port of [3080, 18080, 18200, 18300, 18310, 18431, 19988, 18600]) await expect(pickProbePort(port)).rejects.toThrow('outside')
    const port = await pickProbePort()
    expect(port).toBeGreaterThanOrEqual(PROBE_PORT_RANGE.first)
    expect(port).toBeLessThanOrEqual(PROBE_PORT_RANGE.last)
  })
})

describe('the curl config', () => {
  it('holds the URL and each header as a quoted line, so a link and a cookie never sit on a command line', () => {
    expect(curlConfig('http://127.0.0.1:18661/?token=ONE', ['Host: a.example', 'Cookie: dsh-auth-1=abc; other=2'])).toBe(
      'url = "http://127.0.0.1:18661/?token=ONE"\nheader = "Host: a.example"\nheader = "Cookie: dsh-auth-1=abc; other=2"\n',
    )
    expect(curlConfig('http://127.0.0.1:18661/', [])).toBe('url = "http://127.0.0.1:18661/"\n')
  })

  it('escapes quotes and backslashes, and refuses a line break that would end a config line', () => {
    expect(curlConfig('http://x/?a="b"\\c', [])).toBe('url = "http://x/?a=\\"b\\"\\\\c"\n')
    expect(() => curlConfig('http://x/', ['Cookie: a=b\nurl = "http://evil/"'])).toThrow('line break')
    expect(() => curlConfig('http://x/\r', [])).toThrow('line break')
  })
})
