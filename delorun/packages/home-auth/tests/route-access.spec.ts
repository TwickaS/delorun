/**
 * The gate on plugin Fetch routes (`src/route-access.ts`): every `connection.fetch.register` call in a Delorun package
 * names a path the table classifies, and its code admits a device as its level says. A new route fails here until
 * someone writes its level and reason, so none is left to the default of a plain 403.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PLUGIN_ROUTE_ACCESS, type RouteLevel } from '../src/route-access.ts'

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Every source file under a package's `src`, outside `client`.
 * @param directory - the directory to walk.
 * @returns the file paths.
 */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return entry === 'client' || entry === 'node_modules' || entry === 'lib' ? [] : sources(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })
}

/** One `fetch.register(...)` call: where it is and the text of its argument. */
interface Registration {
  readonly file: string
  readonly path: string
  readonly block: string
}

/**
 * Every `connection.fetch.register(` call of the Delorun packages, with its balanced argument text.
 * @returns the calls.
 */
function registrations(): Registration[] {
  const found: Registration[] = []
  for (const name of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, name, 'src')
    if (!statSync(PACKAGES).isDirectory() || !exists(src)) continue
    for (const file of sources(src)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/fetch\.register\(/g)) {
        let depth = 0
        let end = match.index + match[0].length - 1
        for (; end < text.length; end += 1) {
          if (text[end] === '(') depth += 1
          if (text[end] === ')' && --depth === 0) break
        }
        const block = text.slice(match.index, end + 1)
        const path = /path:\s*([A-Za-z0-9_.]+)/.exec(block)?.[1] ?? (/[{\s]path,/.test(block) ? 'path' : undefined)
        found.push({ file: relative(PACKAGES, file), path: path ?? '(no path)', block })
      }
    }
  }
  return found
}

/**
 * Whether a directory exists.
 * @param path - the path.
 * @returns whether it is a directory.
 */
function exists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (_missing) {
    // A package without sources has no routes.
    return false
  }
}

const GATE = /gateByUnlock|unlocked\(|fullAccessGate/
const FULL_GATE = /phonePowers:\s*'full'/
const READER = /admitApprovedDevice|admitReachDevice|anyDevice|admitPeer,|admitsReach|admitsBill/

/**
 * Whether a registration's code admits a device as the level says.
 * @param level - the table's level.
 * @param block - the registration's text.
 * @returns whether they agree.
 */
function matches(level: RouteLevel, block: string): boolean {
  switch (level) {
    case 'R': return READER.test(block) && !GATE.test(block)
    case 'U': return GATE.test(block) && !FULL_GATE.test(block)
    case 'F': return block.includes('gateByUnlock') && FULL_GATE.test(block)
    case 'K': return block.includes('admitKeyDevice')
    case 'C': return !block.includes('admitPeer') && !GATE.test(block)
    case 'R+U': return READER.test(block) && GATE.test(block)
  }
}

describe('the plugin Fetch routes', () => {
  const found = registrations()

  it('are found in the packages, so the scan below is not empty', () => {
    expect(found.length).toBeGreaterThan(30)
  })

  it('are each classified, with a reason', () => {
    // Pins the table: a route registered without an entry here fails, so nothing is left to the plain 403 default.
    const unclassified = found.filter(({ file, path }) => PLUGIN_ROUTE_ACCESS[file]?.[path] === undefined).map(({ file, path }) => `${file}: ${path}`)
    expect(unclassified).toEqual([])
    for (const routes of Object.values(PLUGIN_ROUTE_ACCESS)) {
      for (const [path, access] of Object.entries(routes)) expect(access.reason.length, path).toBeGreaterThan(10)
    }
  })

  it('list no route that is not registered', () => {
    const registered = new Set(found.map(({ file, path }) => `${file}: ${path}`))
    const stale = Object.entries(PLUGIN_ROUTE_ACCESS).flatMap(([file, routes]) => Object.keys(routes).map(path => `${file}: ${path}`)).filter(key => !registered.has(key))
    expect(stale).toEqual([])
  })

  it('admit a device as their level says', () => {
    // Pins the match: a route classified R that gates on an unlock, or U that admits any device, fails.
    const mismatched = found.flatMap(({ file, path, block }) => {
      const access = PLUGIN_ROUTE_ACCESS[file]?.[path]
      return access === undefined || matches(access.level, block) ? [] : [`${file}: ${path} is ${access.level}`]
    })
    expect(mismatched).toEqual([])
  })

  it('say, at every unlock gate, whether a call of the route renews a sliding unlock', () => {
    const missing: string[] = []
    for (const name of readdirSync(PACKAGES)) {
      const src = join(PACKAGES, name, 'src')
      if (!exists(src)) continue
      for (const file of sources(src)) {
        const text = readFileSync(file, 'utf8')
        for (const match of text.matchAll(/gateByUnlock\(/g)) {
          if (text.slice(Math.max(0, match.index - 20), match.index).includes('function ')) continue
          let depth = 0
          let end = match.index + match[0].length - 1
          for (; end < text.length; end += 1) {
            if (text[end] === '(') depth += 1
            if (text[end] === ')' && --depth === 0) break
          }
          // Pins the choice: a route behind the unlock says whether it renews, so none is left to a default.
          if (!/renews:\s*(true|false|options\.renews|options\.legacy\.renews)/.test(text.slice(match.index, end + 1))) missing.push(relative(PACKAGES, file))
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('see a mismatch when a route\'s code disagrees with its level', () => {
    expect(matches('U', "register({ path: X, admitPeer: admitApprovedDevice(), fetch })")).toBe(false)
    expect(matches('R', "register({ path: X, ...gateByUnlock(home, fetch) })")).toBe(false)
    expect(matches('C', "register({ path: X, admitPeer: admitApprovedDevice(), fetch })")).toBe(false)
    expect(matches('R', "register({ path: X, fetch })")).toBe(false)
    expect(matches('F', "register({ path: X, ...gateByUnlock(home, fetch, { renews: true }) })")).toBe(false)
    expect(matches('U', "register({ path: X, ...gateByUnlock(home, fetch, { renews: true, phonePowers: 'full' }) })")).toBe(false)
    expect(matches('F', "register({ path: X, ...gateByUnlock(home, fetch, { renews: true, phonePowers: 'full' }) })")).toBe(true)
  })
})

describe('the computer-only table', () => {
  it('gives every row a reason, and lists each denied action family and each protected plugin row', async () => {
    const { COMPUTER_ONLY } = await import('../src/route-access.ts')
    const { COMPUTER_ONLY_ROW_MODULES, REACH_DENIED_ACTIONS } = await import('../src/reach-access.ts')
    for (const row of COMPUTER_ONLY) expect(row.reason.length, row.id).toBeGreaterThan(10)
    const ids = new Set(COMPUTER_ONLY.map(row => row.id))
    // Pins the link to the code: an action or plugin row added there without a row here fails.
    for (const action of Object.keys(REACH_DENIED_ACTIONS)) {
      expect(ids.has(action) || (action.startsWith('account/') && ids.has('account/*')) || (action.startsWith('event:deepseek-account/') && ids.has('account/*')), action).toBe(true)
    }
    for (const module of Object.keys(COMPUTER_ONLY_ROW_MODULES)) expect(ids.has(module), module).toBe(true)
  })
})
