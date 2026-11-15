/**
 * Screenshots the social card page into `apps/website/public/og.png` (1200 by 630) through the user's own Chrome.
 * The page is `apps/website/scripts/og.html`, written by `render-og.ts`. The script serves the `delorun/` root on
 * 127.0.0.1, opens a browse session that allows only that origin, waits for the brand fonts, and saves the screenshot.
 * Usage: `node_modules/.bin/tsx delorun/packages/brand/scripts/render-og-png.ts` from the repository root. It needs the
 * `browse` CLI (`BROWSE_BIN` names its executable; the default is `browse` on the path) and fails when a brand font does not load.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

const DELORUN_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const OUTPUT = join(DELORUN_ROOT, 'apps/website/public/og.png')
const PAGE_PATH = '/apps/website/scripts/og.html'
const BROWSE = process.env.BROWSE_BIN ?? 'browse'
/** Characters of base64 per `browse execute` call; one call returns a bounded value. */
const CHUNK = 8000
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
}

/** Loads the page, checks the brand fonts and keeps the PNG as base64 on the page's `window`. */
function shootCode(pageUrl: string, key: string): string {
  return `
    await page.setViewportSize({ width: 1200, height: 630 });
    await page.goto(${JSON.stringify(pageUrl)}, { waitUntil: 'load' });
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        sans: document.fonts.check('500 72px "Schibsted Grotesk"'),
        mono: document.fonts.check('500 34px "JetBrains Mono"'),
        bodyFamily: getComputedStyle(document.body).fontFamily,
      };
    });
    const png = (await page.screenshot({ type: 'png' })).toString('base64');
    await page.evaluate(([k, v]) => { window[k] = v; }, [${JSON.stringify(key)}, png]);
    return { fonts, length: png.length };
  `
}

/** Serves `root` on 127.0.0.1 with a random port; paths outside `root` get 404. */
function serve(root: string): Promise<{ origin: string; close: () => void }> {
  const server = createServer((request, response) => {
    const requested = normalize(decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/'))
    const file = join(root, requested)
    if (!file.startsWith(root) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
    response.end(readFileSync(file))
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

const run = promisify(execFile)

/**
 * Runs one browse command and returns its stdout. It is asynchronous so the page server keeps answering while the
 * browser loads the page.
 * @param args the browse arguments
 * @returns the command's stdout
 */
async function browse(args: string[]): Promise<string> {
  try {
    const { stdout } = await run(BROWSE, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    return stdout
  } catch (error) {
    throw new Error(`browse ${args[0]} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/**
 * Runs Playwright code in the session and returns the JSON envelope's value.
 * @param session the browse session id
 * @param code the Playwright script; its `return` value comes back as the envelope's `value`
 * @returns the returned value
 */
async function execute<T>(session: string, code: string): Promise<T> {
  const envelope = JSON.parse(await browse(['execute', '-s', session, '--json', '--timeout-ms', '90000', code])) as {
    ok: boolean
    value: T | null
    error?: unknown
  }
  if (!envelope.ok || envelope.value === null) throw new Error(`browse execute failed: ${JSON.stringify(envelope.error ?? envelope)}`)
  return envelope.value
}

const server = await serve(DELORUN_ROOT)
const session = `brand-og-${randomBytes(4).toString('hex')}`
const key = `__brandOg${randomBytes(4).toString('hex')}`
try {
  await browse(['session', 'new', session, '--allow-origin', server.origin])
  const shot = await execute<{ fonts: { sans: boolean; mono: boolean; bodyFamily: string }; length: number }>(
    session,
    shootCode(server.origin + PAGE_PATH, key),
  )
  const { fonts, length } = shot
  if (!fonts.sans || !fonts.mono) throw new Error(`brand fonts did not load: ${JSON.stringify(fonts)}`)
  let base64 = ''
  for (let offset = 0; offset < length; offset += CHUNK) {
    base64 += await execute<string>(session, `return await page.evaluate(([k, a, b]) => window[k].slice(a, b), [${JSON.stringify(key)}, ${offset}, ${offset + CHUNK}]);`)
  }
  const bytes = Buffer.from(base64, 'base64')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width !== 1200 || height !== 630) throw new Error(`expected 1200x630, got ${width}x${height}`)
  writeFileSync(OUTPUT, bytes)
  process.stdout.write(`wrote ${OUTPUT} (${width}x${height}); body font ${fonts.bodyFamily}\n`)
} finally {
  await browse(['session', 'delete', session])
  server.close()
}
