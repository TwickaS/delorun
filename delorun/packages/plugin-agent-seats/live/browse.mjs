/**
 * Pictures of a live-agent studio through the owner's Chrome, for a studio on 127.0.0.1 only (`localhost.` too: it resolves to loopback but the page counts it as a remote address, which shows a phone's card). A thin driver of the
 * `browse` CLI (Windows binary from WSL); it is a hand-run tool, never part of a vitest lane.
 *
 *   node browse.mjs open <url>                      open a tab at a loopback URL, print its id
 *   node browse.mjs js <tab> <script.js>            run a Playwright-style script in the tab, print its result
 *   node browse.mjs emulate <tab> <w> <h> <light|dark> [mobile]
 *   node browse.mjs shot <tab> <out.png>            save the tab's viewport at device resolution
 *
 * The binary comes from BROWSE_EXE, or `browse.exe` on PATH.
 * @module @delorun/plugin-agent-seats/live/browse
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync } from 'node:fs'

const exe = process.env.BROWSE_EXE ?? 'browse.exe'
const [command, ...args] = process.argv.slice(2)

/** Run the browse binary with a JSON argument object for a tool. */
function tool(name, json) {
  return execFileSync(exe, [name, '--json', JSON.stringify(json)], { encoding: 'utf8', timeout: 90_000 })
}

if (command === 'open') {
  const url = new URL(args[0])
  if (!['127.0.0.1', 'localhost', 'localhost.', '[::1]'].includes(url.hostname)) throw new Error('only loopback pages')
  const script = `await page.goto(${JSON.stringify(url.href)})\nreturn page.url()`
  const out = execFileSync(exe, ['execute', '--file', '-'], { input: script, encoding: 'utf8', timeout: 90_000 })
  process.stdout.write(out.match(/^tab: (\d+)/mu)?.[1] ?? out)
} else if (command === 'js') {
  const out = execFileSync(exe, ['execute', '--tab', args[0], '--file', '-'], { input: readFileSync(args[1], 'utf8'), encoding: 'utf8', timeout: 120_000 })
  process.stdout.write(out)
} else if (command === 'emulate') {
  const [tab, width, height, scheme, mobile] = args
  const viewport = { width: Number(width), height: Number(height), deviceScaleFactor: mobile === 'mobile' ? 2 : 1, ...mobile === 'mobile' ? { mobile: true } : {} }
  process.stdout.write(tool('emulate', { tab: Number(tab), viewport, colorScheme: scheme, ...mobile === 'mobile' ? { touch: true } : {} }))
} else if (command === 'shot') {
  const out = tool('screenshot', { tab: Number(args[0]), format: 'png', scale: 'device' })
  const windowsPath = out.split('\n')[0].trim()
  const local = windowsPath.replace(/^([A-Za-z]):\\/u, (_all, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/')
  copyFileSync(local, args[1])
  process.stdout.write(`${args[1]}\n`)
} else {
  throw new Error('usage: browse.mjs open|js|emulate|shot ...')
}
