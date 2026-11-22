import { describe, expect, it, vi } from 'vitest'
import { connectWslHome } from '../src/wsl-connection.ts'
import { WslHomeError } from '../src/wsl-home.ts'

const STUDIO = 'http://127.0.0.1:18601/'
const LINK = 'http://127.0.0.1:18601/?token=SECRET-ONE-TIME'
const rows = [{ kind: 'script', placement: 'head', text: 'globalThis.A=1' }]

/** `wsl.exe -l -q` prints UTF-16LE with a byte-order mark. */
const listing = (...names: string[]): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${names.join('\r\n')}\r\n`, 'utf16le')])

/** A `wsl.exe` stand-in: the distribution list, then the status, then the link. */
function runner(version: string, link = LINK, linkCode = 0, distros: readonly string[] = ['Ubuntu']) {
  return vi.fn(async (args: readonly string[], _deadline?: number) => {
    if (args[0] === '-l') return { code: 0, stdout: listing(...distros) }
    const json = args.includes('status')
      ? JSON.stringify({ ok: true, status: { state: 'ready', pid: 1, runtime: { current: version, running: version }, chats: 0, studio: STUDIO } })
      : `${link}\nhint\n`
    return { code: args.includes('status') ? 0 : linkCode, stdout: Buffer.from(json) }
  })
}
const deps = (overrides: Record<string, unknown> = {}) => ({
  run: runner('0.1.0-preview.4'), exchange: vi.fn(async () => 'dsh-auth-1=COOKIE'), fetchRows: vi.fn(async () => rows), ...overrides,
})

describe('connectWslHome', () => {
  it('returns the origin without a token, the cookie and the boot rows', async () => {
    const calls = deps()
    const connection = await connectWslHome('Ubuntu', 'default', calls)
    expect(connection).toEqual({
      origin: 'http://127.0.0.1:18601', cookie: 'dsh-auth-1=COOKIE', version: '0.1.0-preview.4',
      injections: rows,
    })
    expect(calls.exchange).toHaveBeenCalledWith(LINK)
    expect(calls.fetchRows).toHaveBeenCalledWith('http://127.0.0.1:18601', 'dsh-auth-1=COOKIE')
    expect(JSON.stringify(connection)).not.toContain('SECRET')
  })

  it('gives every wsl.exe call a deadline, and puts no link on a command line', async () => {
    const calls = deps()
    await connectWslHome('Ubuntu', 'default', calls)
    expect(calls.run).toHaveBeenCalledTimes(3)
    for (const [args, deadline] of calls.run.mock.calls) {
      expect(deadline, args.join(' ')).toEqual(expect.any(Number))
      expect(deadline).toBeGreaterThan(0)
      expect(args.join(' ')).not.toMatch(/token|SECRET|https?:/iu)
    }
  })

  it('shows the "update this home" page for an older home and the "update the app" page for a newer one, and never reads a link', async () => {
    const range = '>=0.1.0-preview.4 <0.2.0-0'
    const older = deps({ run: runner('0.0.9') })
    await expect(connectWslHome('Ubuntu', 'default', older)).rejects.toMatchObject({ code: 'home-too-old', detail: { distro: 'Ubuntu', version: '0.0.9', range } })
    expect(older.run).toHaveBeenCalledTimes(2)
    expect(older.exchange).not.toHaveBeenCalled()
    const newer = deps({ run: runner('0.3.0') })
    await expect(connectWslHome('Ubuntu', 'default', newer)).rejects.toMatchObject({ code: 'home-too-new', detail: { version: '0.3.0', range } })
    expect(newer.exchange).not.toHaveBeenCalled()
    await expect(connectWslHome('Ubuntu', 'default', deps({ run: runner('weird') }))).rejects.toMatchObject({ code: 'version-unreadable' })
  })

  it('refuses a stale or used link with a plain error that does not hold the link', async () => {
    const used = deps({ exchange: vi.fn(async () => { throw new Error(`Desktop Host authentication failed for ${LINK}`) }) })
    const failure = await connectWslHome('Ubuntu', 'default', used).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WslHomeError)
    expect(failure).toMatchObject({ code: 'exchange-failed' })
    expect(JSON.stringify([(failure as Error).message, (failure as WslHomeError).detail, (failure as Error).cause])).not.toContain('SECRET')
  })

  it('runs nothing in a distribution that the list does not hold by its exact name', async () => {
    for (const listed of [['Debian'], ['ubuntu'], []]) {
      const calls = deps({ run: runner('0.1.0-preview.4', LINK, 0, listed) })
      await expect(connectWslHome('Ubuntu', 'default', calls)).rejects.toMatchObject({ code: 'distro-missing', detail: { distro: 'Ubuntu' } })
      expect(calls.run).toHaveBeenCalledTimes(1)
      expect(calls.run.mock.calls[0]![0]).toEqual(['-l', '-q'])
      expect(calls.exchange).not.toHaveBeenCalled()
    }
  })

  it('reads a home that accepts the exchange and then does not answer as a missing port forward, not a refused link', async () => {
    const timeout = deps({ exchange: vi.fn(async () => { throw new DOMException('The operation timed out', 'TimeoutError') }) })
    await expect(connectWslHome('Ubuntu', 'default', timeout)).rejects.toMatchObject({ code: 'forwarding-unreachable' })
  })

  it('reports a home whose rows cannot be read in time or at all as a plain failure, never a crash', async () => {
    for (const failure of [new TypeError('fetch failed'), new DOMException('The operation timed out', 'TimeoutError')]) {
      const calls = deps({ fetchRows: vi.fn(async () => { throw failure }) })
      await expect(connectWslHome('Ubuntu', 'default', calls)).rejects.toMatchObject({ code: 'rows-unavailable' })
    }
  })

  it('gives its own request for the boot rows a deadline and no redirect', async () => {
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => new Response(JSON.stringify(rows)))
    vi.stubGlobal('fetch', fetch)
    try {
      await connectWslHome('Ubuntu', 'default', deps({ fetchRows: undefined }))
    } finally { vi.unstubAllGlobals() }
    const init = fetch.mock.calls[0]![1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.redirect).toBe('manual')
    expect(fetch.mock.calls[0]![0].href).toBe('http://127.0.0.1:18601/index-injections.json')
  })

  it('reaches a delorun that only the login shell finds, reads the link past start-up noise and carries no link on any command line', async () => {
    const shellStarts: (readonly string[])[] = []
    const run = vi.fn(async (args: readonly string[], _deadline?: number) => {
      if (args[0] === '-l') return { code: 0, stdout: listing('Ubuntu') }
      if (args.includes('id')) return { code: 0, stdout: Buffer.from('alice\n') }
      if (args.includes('getent')) return { code: 0, stdout: Buffer.from('alice:x:1000:1000::/home/alice:/bin/bash\n') }
      if (args[3] === 'delorun') return { code: 127, stdout: Buffer.alloc(0) }
      shellStarts.push(args)
      const status = JSON.stringify({ ok: true, status: { state: 'ready', pid: 1, runtime: { current: '0.1.0-preview.4', running: '0.1.0-preview.4' }, chats: 0, studio: STUDIO } })
      return { code: 0, stdout: Buffer.from(args.includes('status') ? `nvm ready\n${status}\n` : `nvm ready\n${LINK}\nhint\n`) }
    })
    const calls = deps({ run })
    const connection = await connectWslHome('Ubuntu', 'default', calls)
    expect(connection.origin).toBe('http://127.0.0.1:18601')
    expect(calls.exchange).toHaveBeenCalledWith(LINK)
    expect(shellStarts).toHaveLength(2)
    for (const args of shellStarts) expect(args.slice(2, 8)).toEqual(['--exec', '/bin/bash', '-l', '-i', '-c', 'exec delorun $@'])
    expect(JSON.stringify(run.mock.calls)).not.toContain('SECRET')
  })

  it('shows the delorun-missing page when neither start finds delorun', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-l') return { code: 0, stdout: listing('Ubuntu') }
      if (args.includes('id')) return { code: 0, stdout: Buffer.from('alice\n') }
      if (args.includes('getent')) return { code: 0, stdout: Buffer.from('alice:x:1000:1000::/home/alice:/bin/bash\n') }
      return { code: 127, stdout: Buffer.alloc(0) }
    })
    const calls = deps({ run })
    await expect(connectWslHome('Ubuntu', 'default', calls)).rejects.toMatchObject({ code: 'delorun-missing', detail: { distro: 'Ubuntu' } })
    expect(calls.exchange).not.toHaveBeenCalled()
  })

  it('tells a missing port forward from a refused link', async () => {
    const unreachable = deps({ exchange: vi.fn(async () => { throw new TypeError('fetch failed') }) })
    await expect(connectWslHome('Ubuntu', 'default', unreachable)).rejects.toMatchObject({ code: 'forwarding-unreachable' })
  })

  it('refuses a home that gives no usable boot rows, and a home that is not running', async () => {
    for (const answer of [undefined, '<html></html>', [{ kind: 'eval' }]]) {
      await expect(connectWslHome('Ubuntu', 'default', deps({ fetchRows: vi.fn(async () => answer) }))).rejects.toMatchObject({ code: 'rows-unavailable' })
    }
    const stopped = deps({ run: vi.fn(async (args: readonly string[]) => (args[0] === '-l'
      ? { code: 0, stdout: listing('Ubuntu') } : { code: 3, stdout: Buffer.from('{"ok":false,"state":"not-running"}') })) })
    await expect(connectWslHome('Ubuntu', 'default', stopped)).rejects.toMatchObject({ code: 'home-not-running' })
  })
})
