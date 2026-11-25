/**
 * Opening the studio end to end over a temporary home: a home process runs in this process with a Host made of
 * upstream's web server and connection, and `delorun open`, `delorun open --print` and setup's ending obtain links
 * from it through `studio.open-token`. With Delorun's one-time launch tokens a link signs in once and a second use is
 * told to run `delorun open`; with the switch at its parity value the reusable process token keeps working. Nothing
 * the commands print contains a token except `--print`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { ensureHomeTree, newStartId, writeNewStartToken } from '@delorun/home'
import { CountingChatGate, HomeProcess, updateChannelProbe, updateSocketPath } from '@delorun/home-process'
import { Redactor, type DelorunLogger } from '@delorun/logs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { EXIT } from '../../src/exit.ts'
import { announceStudio } from '../../src/open/announce.ts'
import { openCommand, runOpen } from '../../src/open/command.ts'
import { hostStudioLink } from '../../src/open/host-link.ts'
import { computerOpener, describeOpening, openStudio, openerFor, openHint, requestStudioLink, spawnCommand, type StudioOpener } from '../../src/open/studio.ts'
import { HOME_STATUS_TIMEOUT_MS } from '@delorun/contract-home-layout'
import { queryHomeStatus } from '@delorun/home-process'

const PROFILE = 'default'
const SILENT: DelorunLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
const TIMEOUT = { timeout: 60_000 }

let base: string
let home: string
const cleanups: (() => Promise<void>)[] = []

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dop-')))
  home = join(base, 'h')
  mkdirSync(join(base, 'o'), { mode: 0o700 })
  await ensureHomeTree(home, PROFILE)
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(base, { recursive: true, force: true })
})

/** An in-memory credential store holding the browser-session secret. */
function memoryCredentials(): object {
  let record: unknown
  return {
    readRecord: () => Promise.resolve(record),
    modifyRecord: async (_key: unknown, mutate: (current: unknown) => Promise<unknown>) => {
      const next = await mutate(record)
      if (next !== undefined) record = next
      return record
    },
    deleteRecord: () => {
      record = undefined
      return Promise.resolve()
    },
  }
}

/** A Host made of upstream's web server and connection, whose fallback serves the index after `authorizeIndex`. */
async function studioHost(connection: Connection.ConnectionConfig): Promise<{ readonly ctx: Context, readonly origin: string }> {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  ctx.provide('credentials', memoryCredentials() as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection, connection)
  ctx.webServer.registerFallback((req, res) => {
    if (ctx.connection.authorizeIndex(req, res)) res.end('index')
  })
  return { ctx, origin: `http://127.0.0.1:${String(ctx.webServer.port)}` }
}

/** Run a home process in this process whose Host is `ctx`, or one that serves no studio. */
async function runHome(ctx: Context | undefined): Promise<void> {
  const listeners: (() => void)[] = []
  const running = await HomeProcess.start({
    home, profile: PROFILE, running: brandString<RuntimeVersion>('1.0.0'), startId: newStartId(),
    host: { boot: async () => Promise.resolve({
      chats: new CountingChatGate(), failedRows: () => [], rows: () => [], protection: () => undefined,
      studio: () => ctx === undefined ? undefined : `http://127.0.0.1:${String(ctx.webServer.port)}/`,
      studioLink: port => ctx === undefined ? { kind: 'unavailable', reason: 'the Host serves no studio' } : hostStudioLink(ctx, port),
      check: async () => Promise.resolve({ passed: true }), reload: async () => Promise.resolve({ ok: true }), close: async () => Promise.resolve(), suspend: async () => Promise.resolve(),
    }) },
    preStart: () => Promise.resolve(),
    probe: updateChannelProbe(home, PROFILE), logger: SILENT, redactor: new Redactor(), updates: undefined, supervisor: undefined,
    onExit: (listener) => { listeners.push(listener) }, onSignal: () => () => undefined, exit: () => {},
  })
  cleanups.push(async () => {
    await running.shutdown(0)
    for (const listener of listeners.splice(0)) listener()
  })
}

/** An opener that can show a browser and records each link it hands to the platform launcher. */
function browserOpener(launched: string[], exit = 0): StudioOpener {
  const run = vi.fn((_command: string, args: readonly string[]) => {
    launched.push(args.at(-1) ?? '')
    return Promise.resolve(exit)
  })
  return { ...computerOpener({}, run, 'linux'), canOpen: () => true }
}

/** Run `delorun open` against the temporary home. */
async function open(args: readonly string[], opener: StudioOpener): Promise<{ readonly code: number, readonly stdout: string, readonly stderr: string }> {
  let stdout = ''
  let stderr = ''
  const context = { env: { HOME: join(base, 'o'), DELORUN_HOME: home }, stdout: (text: string) => { stdout += text }, stderr: (text: string) => { stderr += text } }
  const code = await runOpen(args, context, opener)
  return { code, stdout, stderr }
}

/** Present a link at the studio's own port as a browser that reached it through another address does. */
function visitAs(url: string, port: number, host: string): Promise<{ readonly status: number, readonly body: string }> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const sent = httpRequest({ host: '127.0.0.1', port, path: `${target.pathname}${target.search}`, headers: { host, 'sec-fetch-site': 'none' }, setHost: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }) })
    })
    sent.on('error', reject)
    sent.end()
  })
}

/** Present a link as a browser does, and return the status, the cookie set and the body. */
async function visit(url: string, cookie?: string): Promise<{ readonly status: number, readonly cookie: string | undefined, readonly body: string }> {
  const response = await fetch(url, { redirect: 'manual', headers: { 'sec-fetch-site': 'none', ...cookie === undefined ? {} : { cookie } } })
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.text() }
}

const DELORUN_CONNECTION = { oneTimeLaunchTokens: true, reopenHint: 'run delorun open to open the studio' }

describe('a link from the home process signs in once', TIMEOUT, () => {
  it('opens a link from the home process that signs in once, and reads the address from the status answer', async () => {
    const { ctx, origin } = await studioHost(DELORUN_CONNECTION)
    await runHome(ctx)
    const launched: string[] = []
    const opener = browserOpener(launched)
    expect(Reflect.get(await queryHomeStatus(home, PROFILE, HOME_STATUS_TIMEOUT_MS), 'studio')).toBe(`${origin}/`)
    expect((await openStudio(home, PROFILE, opener)).kind).toBe('opened')
    expect(launched).toHaveLength(1)
    const [url = ''] = launched
    expect(new URL(url).origin).toBe(origin)
    const first = await visit(url)
    expect(first.status).toBe(303)
    expect(first.cookie).toMatch(/^dsh-auth-/)
    expect((await visit(`${origin}/`, first.cookie)).body).toBe('index')
    const again = await visit(url)
    expect(again.status).toBe(401)
    expect(again.cookie).toBeUndefined()
    expect(again.body).toBe('dsh web authentication required; run delorun open to open the studio.\n')
  })
})

describe('delorun open', TIMEOUT, () => {
  it('opens the studio and prints no token; a link the browser did not take is reported without it', async () => {
    const { ctx } = await studioHost(DELORUN_CONNECTION)
    await runHome(ctx)
    const launched: string[] = []
    const opened = await open([], browserOpener(launched))
    expect(opened).toEqual({ code: EXIT.ok, stdout: 'Opened the studio in your browser.\n', stderr: '' })
    expect(launched).toHaveLength(1)
    const failed = await open([], browserOpener(launched, 1))
    expect(failed.code).toBe(EXIT.failed)
    expect(failed.stderr).toBe('No browser took the studio link. Run delorun open --print for a link that signs in once, within one minute.\n')
    expect(`${failed.stdout}${failed.stderr}`).not.toContain('token')
    expect(new Set(launched).size).toBe(2)
  })

  it('prints one link with --print that works once, and says so', async () => {
    const { ctx } = await studioHost(DELORUN_CONNECTION)
    await runHome(ctx)
    const launched: string[] = []
    const printed = await open(['--print'], browserOpener(launched))
    expect(printed.code).toBe(EXIT.ok)
    expect(launched).toEqual([])
    const [url = '', note] = printed.stdout.split('\n')
    expect(printed.stdout.split('token=')).toHaveLength(2)
    expect(note).toBe('This link signs in to the studio once, within one minute; run delorun open --print again for another.')
    expect((await visit(url)).status).toBe(303)
    expect((await visit(url)).status).toBe(401)
  })

  it('keeps upstream\'s reusable token with the switch at its parity value, and says the link keeps working', async () => {
    const { ctx } = await studioHost({})
    await runHome(ctx)
    const printed = await open(['--print', '--profile', PROFILE], browserOpener([]))
    const [url = '', note] = printed.stdout.split('\n')
    expect(note).toBe('This link signs in to the studio for as long as Delorun runs; anyone who has it can use it, so keep it to yourself.')
    expect((await visit(url)).status).toBe(303)
    expect((await visit(url)).status).toBe(303)
  })

  it('prints a link for a forwarded loopback port that signs in only through that port, and refuses a port it cannot be', async () => {
    const { ctx, origin } = await studioHost(DELORUN_CONNECTION)
    await runHome(ctx)
    const studioPort = Number(new URL(origin).port)
    const printed = await open(['--print', '--port', '4000'], browserOpener([]))
    const [url = ''] = printed.stdout.split('\n')
    expect(new URL(url).host).toBe('127.0.0.1:4000')
    expect((await visitAs(url, studioPort, '127.0.0.1:4000')).status).toBe(303)
    const [direct = ''] = (await open(['--print'], browserOpener([]))).stdout.split('\n')
    const elsewhere = await visitAs(direct, studioPort, 'localhost:4000')
    expect(elsewhere).toEqual({ status: 401, body: `dsh web authentication required; this sign-in link was made for 127.0.0.1:${String(studioPort)} and signs in only there; run delorun open to open the studio.\n` })
    for (const port of ['0', '65536', '80a', '+1']) {
      await expect(open(['--print', '--port', port], browserOpener([]))).rejects.toMatchObject({ exit: EXIT.usage, message: `delorun open: --port takes a port from 1 to 65535, not ${JSON.stringify(port)}` })
    }
    const launched: string[] = []
    expect((await open(['--port', '4001'], browserOpener(launched))).code).toBe(EXIT.ok)
    expect(new URL(launched[0] ?? '').host).toBe('127.0.0.1:4001')
  })

  it('reports a home process that serves no studio, a profile with no home process and a computer with no browser', async () => {
    const launched: string[] = []
    expect(await open([], browserOpener(launched))).toEqual({ code: EXIT.notRunning, stdout: '', stderr: "Delorun isn't running. Start it with: delorun start\n" })
    expect(await open(['--print', '--profile', 'work'], browserOpener(launched))).toEqual({ code: EXIT.notRunning, stdout: '', stderr: "Delorun isn't running. Start it with: delorun start --profile work\n" })
    await runHome(undefined)
    expect(Reflect.get(await queryHomeStatus(home, PROFILE, HOME_STATUS_TIMEOUT_MS), 'studio')).toBeUndefined()
    expect(await open([], browserOpener(launched))).toEqual({ code: EXIT.failed, stdout: '', stderr: 'The home process for the profile default did not give a studio link (STUDIO_UNAVAILABLE: the Host serves no studio); see delorun status.\n' })
    expect((await open(['--print'], browserOpener(launched))).code).toBe(EXIT.failed)
    const noBrowser = { ...browserOpener(launched), canOpen: () => false, link: vi.fn() }
    expect(await open([], noBrowser)).toEqual({ code: EXIT.failed, stdout: '', stderr: 'There is no browser to open here. Run delorun open --print for a link that signs in once, within one minute.\n' })
    expect(noBrowser.link).not.toHaveBeenCalled()
    expect(launched).toEqual([])
  })
})

describe('a start\'s announcement', TIMEOUT, () => {
  it('names delorun open, and reports an opened studio on standard output and anything else on standard error', async () => {
    const { ctx } = await studioHost(DELORUN_CONNECTION)
    await runHome(ctx)
    const written: string[] = []
    const output = { stdout: (text: string) => void written.push(`out ${text}`), stderr: (text: string) => void written.push(`err ${text}`) }
    await announceStudio(home, PROFILE, false, output, browserOpener([]))
    await announceStudio(home, PROFILE, true, output, browserOpener([]))
    await announceStudio(home, PROFILE, true, output, browserOpener([], 1))
    expect(written).toEqual([
      'out Run delorun open to open the studio in your browser.\n',
      'out Run delorun open to open the studio in your browser.\n',
      'out Opened the studio in your browser.\n',
      'out Run delorun open to open the studio in your browser.\n',
      'err No browser took the studio link. Run delorun open --print for a link that signs in once, within one minute.\n',
    ])
  })

  it('names the printed link alone where there is no browser, so the hint never contradicts it', async () => {
    const written: string[] = []
    const output = { stdout: (text: string) => void written.push(`out ${text}`), stderr: (text: string) => void written.push(`err ${text}`) }
    const noBrowser = { ...browserOpener([]), canOpen: () => false, link: vi.fn() }
    await announceStudio(home, PROFILE, true, output, noBrowser)
    expect(written).toEqual(['err There is no browser to open here. Run delorun open --print for a link that signs in once, within one minute.\n'])
    expect(noBrowser.link).not.toHaveBeenCalled()
    // A start that was not asked to open the studio still names the command, which works from a browser elsewhere.
    written.length = 0
    await announceStudio(home, PROFILE, false, output, noBrowser)
    expect(written).toEqual(['out Run delorun open to open the studio in your browser.\n'])
  })
})

describe('a home process\'s answer', TIMEOUT, () => {
  it('reads an answer without a link, or no answer, as a refusal', async () => {
    await writeNewStartToken(home, PROFILE)
    for (const reply of ['{"ok":true}\n', '']) {
      // The request line is read before the answer, as the home process reads it.
      const server = createServer((socket) => { socket.once('data', () => { socket.end(reply) }) })
      await new Promise<void>((resolve) => { server.listen(updateSocketPath(home, PROFILE), resolve) })
      expect(await requestStudioLink(home, PROFILE)).toEqual({ kind: 'refused', code: 'NO_ANSWER' })
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('tells a home process that does not answer in time from one that is not running', async () => {
    await writeNewStartToken(home, PROFILE)
    const held = new Set<Socket>()
    const server = createServer((socket) => { held.add(socket) })
    await new Promise<void>((resolve) => { server.listen(updateSocketPath(home, PROFILE), resolve) })
    expect(await requestStudioLink(home, PROFILE)).toEqual({ kind: 'no-answer' })
    expect(describeOpening({ kind: 'no-answer' }, 'work')).toBe('The home process for the profile work is listening but did not answer in time; see delorun status --profile work and delorun logs --profile work.\n')
    for (const socket of held) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    expect(await requestStudioLink(home, PROFILE)).toEqual({ kind: 'not-running' })
  })
})

describe('the opener', () => {
  it('redacts a secret the home process\'s refusal detail quotes', () => {
    const key = ['sk', '0123456789abcdef0123456789abcdef'].join('-')
    const text = describeOpening({ kind: 'refused', code: 'STUDIO_UNAVAILABLE', detail: `the Host answered ${key}` }, 'default')
    expect(text).toContain('STUDIO_UNAVAILABLE: the Host answered [redacted:provider-key]')
    expect(text).not.toContain(key)
  })

  it('runs a command and reports its exit code, 127 when it cannot start', async () => {
    expect(await spawnCommand(process.execPath, ['-e', 'process.exit(3)'], 'ignore')).toBe(3)
    expect(await spawnCommand(process.execPath, ['-e', ''])).toBe(0)
    expect(await spawnCommand(join(tmpdir(), 'no-such-program-delorun'), [], 'ignore')).toBe(127)
    expect(await spawnCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], 'ignore')).toBe(127)
  })

  it('under WSL hands the address to the program BROWSER names, the first entry of its list, instead of Windows', () => {
    expect(openerFor('linux', { WSL_DISTRO_NAME: 'Ubuntu', BROWSER: '/home/me/bin/record-url' }, 'http://x/')).toEqual(['/home/me/bin/record-url', ['http://x/']])
    expect(openerFor('linux', { WSL_DISTRO_NAME: 'Ubuntu', BROWSER: ':firefox:wslview' }, 'http://x/')).toEqual(['firefox', ['http://x/']])
    expect(openerFor('linux', { BROWSER: 'firefox' }, 'http://x/')).toEqual(['xdg-open', ['http://x/']])
    expect(openerFor('win32', { BROWSER: 'firefox' }, 'http://x/')).toEqual(['cmd.exe', ['/c', 'start', '""', 'http://x/']])
  })

  it('picks the launcher of the platform, going through Windows from WSL', async () => {
    expect(openerFor('darwin', {}, 'http://x/')).toEqual(['open', ['http://x/']])
    expect(openerFor('linux', {}, 'http://x/')).toEqual(['xdg-open', ['http://x/']])
    expect(openerFor('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, 'http://x/')).toEqual(['cmd.exe', ['/c', 'start', '""', 'http://x/']])
    expect(openerFor('linux', { WSL_DISTRO_NAME: 'Ubuntu', BROWSER: '' }, 'http://x/')).toEqual(['cmd.exe', ['/c', 'start', '""', 'http://x/']])
    expect(openerFor('win32', {}, 'http://x/')).toEqual(['cmd.exe', ['/c', 'start', '""', 'http://x/']])
    const run = vi.fn(() => Promise.resolve(0))
    expect(await computerOpener({}, run, 'darwin').open('http://x/')).toBe(true)
    expect(run).toHaveBeenLastCalledWith('open', ['http://x/'], 'ignore')
    expect(await computerOpener({}, run).open('http://x/')).toBe(true)
  })

  it('cannot show a browser from an SSH session', () => {
    expect(computerOpener({ SSH_CONNECTION: '1 2 3 4' }).canOpen()).toBe(false)
    expect(computerOpener({ SSH_TTY: '/dev/pts/1' }).canOpen()).toBe(false)
    expect(typeof computerOpener({ SSH_TTY: '' }).canOpen()).toBe('boolean')
    expect(typeof computerOpener({ SSH_CONNECTION: '', SSH_TTY: '' }).canOpen()).toBe('boolean')
  })

  it('runs as delorun open with this computer\'s opener, which shows no browser over SSH', async () => {
    let stderr = ''
    const code = await openCommand.run([], { env: { HOME: join(base, 'o'), DELORUN_HOME: home, SSH_TTY: '/dev/pts/1' }, stdout: () => {}, stderr: (text) => { stderr += text } })
    expect(code).toBe(EXIT.failed)
    expect(stderr).toBe('There is no browser to open here. Run delorun open --print for a link that signs in once, within one minute.\n')
    expect(openHint('work')).toBe('Run delorun open --profile work to open the studio in your browser.\n')
  })

  it('refuses to describe an outcome it does not know', () => {
    expect(() => describeOpening({ kind: 'elsewhere' } as never, PROFILE)).toThrow('unknown opening outcome')
  })
})

describe('the Host\'s studio link', () => {
  /** A Host context with a web server bound to `host`, a connection and, when given, a published address. */
  function hostContext(host: string, advertised?: string): Context {
    const ctx = new Context()
    const origin = `http://${host.includes(':') ? `[${host}]` : host}:4100`
    ctx.provide('webServer', { host, port: 4100, protocol: 'http:', getOrigin: () => origin } as never)
    ctx.provide('connection', { authenticatedUrl: (url: string) => `${url}?token=t`, oneTimeLaunchTokens: true } as never)
    if (advertised !== undefined) ctx.provide('webApp', { getAdvertisedUrl: () => advertised } as never)
    return ctx
  }

  it('is absent without a web server or a connection, and brackets an IPv6 listener', () => {
    const ctx = new Context()
    expect(hostStudioLink(ctx, undefined)).toEqual({ kind: 'unavailable', reason: 'the Host serves no studio' })
    ctx.provide('webServer', { host: '::1', port: 4100 } as never)
    expect(hostStudioLink(ctx, undefined)).toEqual({ kind: 'unavailable', reason: 'the Host serves no studio' })
    expect(hostStudioLink(hostContext('::1', 'http://[::1]:4100'), undefined)).toEqual({ kind: 'link', link: { url: 'http://[::1]:4100/?token=t', oneTime: true } })
    expect(hostStudioLink(hostContext('127.0.0.1'), 4000)).toEqual({ kind: 'link', link: { url: 'http://127.0.0.1:4000/?token=t', oneTime: true } })
  })

  it('refuses a studio on a non-loopback address and one published at a public URL or under a mount', () => {
    expect(hostStudioLink(hostContext('192.0.2.20'), undefined)).toEqual({ kind: 'unavailable', reason: 'the studio listens on 192.0.2.20, which is not a loopback address' })
    expect(hostStudioLink(hostContext('127.0.0.1', 'https://studio.example/ui/'), undefined)).toEqual({ kind: 'unavailable', reason: 'the studio is published at https://studio.example/ui/; open that address instead' })
  })
})
