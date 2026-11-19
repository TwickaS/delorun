import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, type Browser } from '../review/browser.ts'
import { isLocal, open } from '../review/page-tools.ts'

describe('a review pass stays on this machine', () => {
  let browser: Browser
  let origin = ''
  let closeServer = (): void => undefined

  beforeAll(async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><body><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script><img src="https://example.org/pixel.png"><p>hello</p></body></html>')
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', () => { done() }))
    const address = server.address()
    origin = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
    closeServer = () => { server.close() }
    browser = await launch()
  })
  afterAll(async () => {
    await browser.close()
    closeServer()
  })

  it('refuses a request off 127.0.0.1 and records it', async () => {
    const session = await open(browser, { width: 800, scheme: 'light' }, 'offline test')
    const reached: string[] = []
    session.page.on('requestfinished', request => { if (!isLocal(request.url())) reached.push(request.url()) })
    await session.page.goto(origin)
    await session.page.waitForTimeout(500)
    expect(reached).toEqual([])
    const blocked = session.findings.filter(finding => finding.check === 'blocked-request').map(finding => finding.message)
    expect(blocked.some(message => message.includes('challenges.cloudflare.com'))).toBe(true)
    expect(blocked.some(message => message.includes('example.org'))).toBe(true)
    expect(session.findings.some(finding => finding.severity === 'fail')).toBe(false)
    await session.context.close()
  }, 60000)

  it('treats only the local server and inline addresses as local', () => {
    expect(isLocal('http://127.0.0.1:18680/a.js')).toBe(true)
    expect(isLocal('data:image/png;base64,AA')).toBe(true)
    expect(isLocal('https://challenges.cloudflare.com/x')).toBe(false)
    expect(isLocal('http://127.0.0.1.evil.example/')).toBe(false)
  })
})
