import { describe, expect, it, vi } from 'vitest'
import { connectWslHome } from '../src/wsl-connection.ts'
import { WslHomeError } from '../src/wsl-home.ts'

const STUDIO = 'http://127.0.0.1:18601/'
const LINK = 'http://127.0.0.1:18601/?token=SECRET-ONE-TIME'
const rows = [{ kind: 'script', placement: 'head', text: 'globalThis.A=1' }]

/** A `wsl.exe` stand-in: status first, then the link. */
function runner(version: string, link = LINK, linkCode = 0) {
  return vi.fn(async (args: readonly string[], _deadline?: number) => {
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
    expect(calls.run).toHaveBeenCalledTimes(2)
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
    expect(older.run).toHaveBeenCalledTimes(1)
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

  it('tells a missing port forward from a refused link', async () => {
    const unreachable = deps({ exchange: vi.fn(async () => { throw new TypeError('fetch failed') }) })
    await expect(connectWslHome('Ubuntu', 'default', unreachable)).rejects.toMatchObject({ code: 'forwarding-unreachable' })
  })

  it('refuses a home that gives no usable boot rows, and a home that is not running', async () => {
    for (const answer of [undefined, '<html></html>', [{ kind: 'eval' }]]) {
      await expect(connectWslHome('Ubuntu', 'default', deps({ fetchRows: vi.fn(async () => answer) }))).rejects.toMatchObject({ code: 'rows-unavailable' })
    }
    const stopped = deps({ run: vi.fn(async () => ({ code: 3, stdout: Buffer.from('{"ok":false,"state":"not-running"}') })) })
    await expect(connectWslHome('Ubuntu', 'default', stopped)).rejects.toMatchObject({ code: 'home-not-running' })
  })
})
