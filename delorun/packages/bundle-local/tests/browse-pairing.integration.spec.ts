/**
 * Pairing the browse extension from Plugins: the Host runs `browse pair` from the row's pack and streams the one-time
 * code, then the outcome. The program here is a stand-in shell script that prints what browse prints; the real browse
 * and any real browser are never involved. Only the computer may start a pairing: a request from a paired device or
 * with a non-loopback `Host` is refused before anything runs.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { answerBrowsePair, browsePairEnvironment, registerBrowsePairing, type FindPairProgram } from '../src/browse-pairing.ts'
import { BROWSE_PAIR_ROUTE, startBrowsePair, type BrowsePairEvent } from '../src/client/browse-pair-api.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/**
 * A stand-in for browse's program: a shell script that records its arguments and browse variables, then runs `body`.
 * @param body - the script's commands after the recording.
 * @returns the script's path and the files it writes.
 */
function fakeBrowse(body: string): { readonly program: string, readonly ran: string, readonly env: string } {
  const dir = mkdtempSync(join(tmpdir(), 'browse-pair-'))
  roots.push(dir)
  const program = join(dir, 'browse')
  const ran = join(dir, 'ran'), env = join(dir, 'env')
  writeFileSync(program, `#!/bin/sh\necho "$@" > '${ran}'\nenv | grep '^OPENCODE_BROWSER_' | sort > '${env}'\n${body}\n`)
  chmodSync(program, 0o755)
  return { program, ran, env }
}

const PAIRS = 'echo "Pairing code: AB12-CD34"\necho "Open the Extensions menu → browse → Options, enter AB12-CD34, then click Connect."\nsleep 0.2\necho "Paired Chrome on this computer."\nexit 0'
const request = (host: string, body: unknown = { packageName: '@delorun/bundle-real-browser', rowId: 'browser-use-browse' }, signal?: AbortSignal): Request =>
  new Request(`http://dsh.internal${BROWSE_PAIR_ROUTE}`, { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: JSON.stringify(body), ...signal === undefined ? {} : { signal } })
const found = (program: string): FindPairProgram => () => Promise.resolve({ kind: 'program', path: program })

/**
 * Start a pairing through the client's reader against the route's answer.
 * @param find - the row's program.
 * @param env - Delorun's environment.
 * @returns every event the studio reads.
 */
async function pair(find: FindPairProgram, env: Record<string, string> = {}): Promise<BrowsePairEvent[]> {
  const events: BrowsePairEvent[] = []
  const running = {}
  const fetch = (_input: string, init?: RequestInit) => answerBrowsePair(request('127.0.0.1:19010', JSON.parse(init!.body as string)), find, env, running)
  for await (const event of startBrowsePair(fetch, { packageName: '@delorun/bundle-real-browser', rowId: 'browser-use-browse' }, new AbortController().signal)) events.push(event)
  return events
}

describe.skipIf(process.platform === 'win32')('pairing the browse extension', () => {
  it('streams the one-time code, then the browser that connected, from `browse pair` with the code\'s whole lifetime', async () => {
    const browse = fakeBrowse(PAIRS)
    expect(await pair(found(browse.program))).toEqual([{ kind: 'code', code: 'AB12-CD34' }, { kind: 'paired', name: 'Chrome on this computer' }])
    expect(readFileSync(browse.ran, 'utf8').trim()).toBe('pair --wait-seconds 600')
  })

  it('reports a code that ran out, and browse\'s own failure', async () => {
    const expired = fakeBrowse('echo "Pairing code: AB12-CD34"\necho "! Pairing not confirmed. For a fresh code run \\`browse pair\\`."\nexit 1')
    expect(await pair(found(expired.program))).toEqual([{ kind: 'code', code: 'AB12-CD34' }, { kind: 'expired' }])
    const failed = fakeBrowse('echo "browse: the relay did not start" >&2\nexit 1')
    expect(await pair(found(failed.program))).toEqual([{ kind: 'failed', message: 'the relay did not start' }])
  })

  it('keeps every browse variable from Delorun\'s environment out of browse and its relay, as the driver does, and turns updates off', async () => {
    const browse = fakeBrowse(PAIRS)
    await pair(found(browse.program), {
      PATH: process.env.PATH ?? '',
      OPENCODE_BROWSER_ALLOW_ALL_COOKIES: '1', OPENCODE_BROWSER_ALLOW_ALL_STORAGE: '1', OPENCODE_BROWSER_ALLOW_FILE_URLS: '1',
      OPENCODE_BROWSER_ALLOW_FOREGROUND: '1', OPENCODE_BROWSER_FILE_ROOTS: '/', OPENCODE_BROWSER_TOOLS: 'all',
      OPENCODE_BROWSER_AUTO_UPDATE: 'on', OPENCODE_BROWSER_HOME: '/tmp/browse-home',
    })
    expect(readFileSync(browse.env, 'utf8').trim().split('\n')).toEqual(['OPENCODE_BROWSER_AUTO_UPDATE=off', 'OPENCODE_BROWSER_UPDATE_CHECK=0'])
    expect(browsePairEnvironment({ OPENCODE_BROWSER_PORT: '1', opencode_browser_tools: 'all', XDG_DATA_HOME: '/data' })).toEqual({ XDG_DATA_HOME: '/data', OPENCODE_BROWSER_AUTO_UPDATE: 'off', OPENCODE_BROWSER_UPDATE_CHECK: '0' })
  })

  it('refuses a request whose Host is not the computer\'s loopback, before running anything', async () => {
    const browse = fakeBrowse(PAIRS)
    for (const host of ['phone.example.ts.net', '192.168.1.20:3080', '']) {
      const answer = await answerBrowsePair(request(host), found(browse.program), {}, {})
      expect(answer.status).toBe(403)
      expect(await answer.json()).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
    }
    expect(existsSync(browse.ran)).toBe(false)
  })

  it('admits no paired device: the route declares no admitPeer, so the Connection answers a device 403', () => {
    const routes: { path: string, admitPeer?: unknown }[] = []
    const effects: (() => void)[] = []
    const scope = { effect: (make: () => () => void) => { effects.push(make()) }, connection: { fetch: { register: (route: { path: string, admitPeer?: unknown }) => { routes.push(route); return () => Promise.resolve() } } } }
    registerBrowsePairing(scope as never, found('/unused'))
    expect(routes).toEqual([expect.objectContaining({ path: BROWSE_PAIR_ROUTE })])
    expect('admitPeer' in routes[0]!).toBe(false)
  })

  it('answers a row without a browse pairing, an unsupported computer and a malformed request without running anything', async () => {
    const at = (find: FindPairProgram, body?: unknown) => answerBrowsePair(request('localhost:19010', body), find, {}, {})
    expect((await at(() => Promise.resolve({ kind: 'unknown-row' }))).status).toBe(404)
    expect((await at(() => Promise.resolve({ kind: 'unsupported' }))).status).toBe(409)
    expect((await at(found('/unused'), { packageName: 1 })).status).toBe(400)
  })

  it('ends the pairing before when a new one starts, and the running one when the request closes', async () => {
    const slow = fakeBrowse('echo "Pairing code: AB12-CD34"\nexec sleep 30')
    const running = {}
    const first = await answerBrowsePair(request('127.0.0.1'), found(slow.program), {}, running)
    const second = new AbortController()
    const replacing = await answerBrowsePair(request('127.0.0.1', undefined, second.signal), found(slow.program), {}, running)
    // The first pairing ends without an outcome; it may have shown its code before the second started.
    expect((await first.text()).split('\n').filter(line => line !== '' && !line.includes('"code"'))).toEqual([])
    const reader = replacing.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"kind":"code","code":"AB12-CD34"}\n')
    second.abort()
    expect((await reader.read()).done).toBe(true)
  })
})
