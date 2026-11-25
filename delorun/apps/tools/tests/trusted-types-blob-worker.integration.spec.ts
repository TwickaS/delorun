/**
 * The `delorun-blob-worker` Trusted Types policy, proved in a real browser.
 *
 * The defect this covers is not that a function returns the wrong string: it is
 * that `new Worker(blobUrl)` throws under the reach listener's Content Security
 * Policy, because the `Worker` constructor is a TrustedScriptURL sink and the
 * policy admitted only paths under `/plugins/`. A unit assertion on the policy
 * function cannot see that, so this spec serves a page under the reach
 * listener's own policy, loads the real `page-policy` module into it, and
 * constructs a Worker.
 *
 * The page is served by a loopback server this spec owns, and the browser is the
 * repository's Playwright Chromium. Each denial test names the check whose
 * removal makes it fail.
 */
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { chromium, type Browser } from 'playwright'
// The reach listener's own policy function, imported from its source: this spec's project resolves no workspace
// package names, and the value under test is the exact header the listener sends. Its own imports are type-only
// except for the authenticator's Cordis base class, which this spec stubs below so the source loads unbuilt.
import { reachContentSecurityPolicy } from '../../../../packages/client/connection/src/reach.ts'

/** The nonce the served page carries, and the one its policy names. */
const NONCE = 'n0nce-n0nce-n0nce-n0nce-n0nce'

/** The page-policy module's source, bundled for the browser. */
const POLICY_ENTRY = fileURLToPath(new URL('../../../../packages/client/web/src/page-policy.ts', import.meta.url))

/**
 * The page the browser loads: the real policy module, then a probe that uses it.
 * @param policyScript - the bundled policy module's text.
 * @returns the HTML document.
 */
function page(policyScript: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>blob worker</title></head><body>
<script nonce="${NONCE}">${policyScript}</script>
<script nonce="${NONCE}">
// The policy module installs itself on evaluation; the probe below reads the stash it left.
window.__probe = async (kind) => {
  const stash = globalThis.__DSH_TRUSTED_TYPES__
  const source = 'self.onmessage = (event) => self.postMessage("alive:" + event.data)'
  const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  const out = { hasStash: stash !== undefined, hasBlobWorker: stash?.blobWorker !== undefined }
  const mint = (url) => stash?.blobWorker === undefined ? url : stash.blobWorker.createScriptURL(url)
  const run = async (worker) => {
    out.constructed = 'constructed'
    out.reply = await new Promise((resolve) => {
      worker.onmessage = (event) => resolve(event.data)
      worker.onerror = (event) => resolve('error:' + event.message)
      setTimeout(() => resolve('timeout'), 5000)
      worker.postMessage('ping')
    })
    worker.terminate()
  }
  try {
    if (kind === 'plain') {
      // A plain string where a TrustedScriptURL is required: the constructor must refuse it.
      new Worker(blob, { name: 'probe-plain' })
      out.constructed = 'constructed'
    } else if (kind === 'foreign') {
      // Another origin's blob URL: the policy must refuse it, so the constructor never runs.
      const foreign = mint('blob:https://evil.test/00000000-0000-0000-0000-000000000000')
      // A browser wraps the policy's null as an empty TrustedScriptURL, so the refusal is read from the string form.
      out.minted = String(foreign)
      if (foreign === null || out.minted === '') { out.constructed = 'refused-by-policy'; return out }
      new Worker(foreign, { name: 'probe-foreign' })
      out.constructed = 'constructed'
    } else if (kind === 'data') {
      const data = mint('data:text/javascript,self.postMessage(1)')
      out.minted = String(data)
      if (data === null || out.minted === '') { out.constructed = 'refused-by-policy'; return out }
      new Worker(data, { name: 'probe-data' })
      out.constructed = 'constructed'
    } else if (kind === 'same-origin-path') {
      // A same-origin script path is not a blob URL: the protocol check is what refuses it.
      const path = mint('/plugins/a/client.js')
      out.minted = String(path)
      if (path === null || out.minted === '') { out.constructed = 'refused-by-policy'; return out }
      new Worker(path, { name: 'probe-path' })
      out.constructed = 'constructed'
    } else {
      // The admitted case: this page's own blob URL, minted through the policy.
      const trusted = mint(blob)
      out.minted = String(trusted)
      await run(new Worker(trusted, { name: 'probe-own' }))
    }
  } catch (error) {
    out.constructed = 'threw: ' + error.name + ': ' + error.message
  }
  return out
}
</script></body></html>`
}

let server: Server
let origin: string
let browser: Browser
let policyScript: string

beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    // An IIFE, because the page loads it as a classic script: an ES module's `export` statement is a syntax error there.
    build: { write: false, minify: false, target: 'es2022', lib: { entry: POLICY_ENTRY, formats: ['iife'], name: 'DshPagePolicy', fileName: 'page-policy' } },
  })
  const outputs = Array.isArray(result) ? result : [result]
  const chunk = outputs.flatMap(output => output.output).find(entry => entry.type === 'chunk')
  if (chunk === undefined || chunk.type !== 'chunk') throw new Error('the policy module did not bundle')
  policyScript = chunk.code
  server = createServer((request, response) => {
    // The reach listener's own policy, or the same policy with the two directives this change adds taken back out,
    // which is the header the four capabilities failed under.
    const policy = request.url === '/before-the-fix'
      ? reachContentSecurityPolicy(NONCE)
        .replace("worker-src 'self' blob:", "worker-src 'self'")
        .replace('trusted-types default delorun-plugin-loader delorun-blob-worker', 'trusted-types default delorun-plugin-loader')
      : reachContentSecurityPolicy(NONCE)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': policy })
    response.end(page(policyScript))
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the probe server has no port')
  origin = `http://127.0.0.1:${String(address.port)}`
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>(resolve => { server?.close(() => { resolve() }) })
})

/**
 * Load the served page and run one probe in it.
 * @param kind - which probe to run.
 * @param path - the served path, which selects the policy.
 * @returns what the probe saw, and the console refusals the browser reported.
 */
async function probe(kind: 'own' | 'plain' | 'foreign' | 'data' | 'same-origin-path', path = '/'): Promise<Record<string, unknown>> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const refusals: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') refusals.push(message.text()) })
    await page.goto(`${origin}${path}`)
    const result = await page.evaluate(k => (globalThis as unknown as { __probe: (kind: string) => Promise<Record<string, unknown>> }).__probe(k), kind)
    return { ...result, refusals }
  } finally {
    await context.close()
  }
}

describe('the delorun-blob-worker policy in a real browser', () => {
  // The whole defect, end to end: under the reach listener's own header the Worker constructs from this page's
  // blob URL and runs. Removing the policy name from the trusted-types directive, or blob: from worker-src, fails it.
  it('constructs a Worker from this page\'s own blob URL and the Worker runs', async () => {
    const result = await probe('own')
    expect(result.hasBlobWorker).toBe(true)
    expect(result.minted).toBeTypeOf('string')
    expect(result.constructed).toBe('constructed')
    expect(result.reply).toBe('alive:ping')
    expect(result.refusals).toEqual([])
  }, 90_000)

  // The header before this change: the policy name is not in the trusted-types directive, so the policy cannot be
  // created and the constructor throws the TrustedScriptURL TypeError the four capabilities reported.
  it('reproduces the failure under the header the four capabilities failed on', async () => {
    const before = await probe('own', '/before-the-fix')
    // The policy cannot be created, so the stash carries none and the raw URL reaches the constructor.
    expect(before.hasBlobWorker).toBe(false)
    expect(String(before.constructed)).toContain('TrustedScriptURL')
    expect(before.refusals.some(line => line.includes('delorun-blob-worker'))).toBe(true)
  }, 90_000)

  // Removing the blobWorker policy from the stash, or handing the constructor the raw URL, makes this fail.
  it('refuses a plain string where a TrustedScriptURL is required', async () => {
    const result = await probe('plain')
    expect(String(result.constructed)).toMatch(/^threw: TypeError/)
    expect(result.refusals.some(line => line.includes('TrustedScriptURL'))).toBe(true)
  }, 90_000)

  // Admitting every blob: URL, rather than only a same-origin one, makes this fail.
  it('refuses a blob URL from another origin', async () => {
    const result = await probe('foreign')
    expect(result.minted).toBe('')
    expect(result.constructed).toBe('refused-by-policy')
  }, 90_000)

  // Admitting data: URLs makes this fail.
  it('refuses a data: script URL', async () => {
    const result = await probe('data')
    expect(result.minted).toBe('')
    expect(result.constructed).toBe('refused-by-policy')
  }, 90_000)

  // Dropping the protocol check makes this fail: a same-origin path resolves to the page's own origin, so only the
  // blob: requirement refuses it.
  it('refuses a same-origin script path, which is not a blob URL', async () => {
    const result = await probe('same-origin-path')
    expect(result.minted).toBe('')
    expect(result.constructed).toBe('refused-by-policy')
  }, 90_000)
})
