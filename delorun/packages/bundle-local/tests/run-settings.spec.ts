/**
 * The "How Delorun runs" routes over a real profile directory and home in a temporary folder, with the web server, the
 * reach service, Tailscale and the clock faked. Each denial names the check whose removal makes it fail: who may call a
 * route (the hook and the peer gate), what the home checks itself before it writes (the phrase, the code, the root
 * user, the ticket, the port) and what a refused call leaves behind (nothing).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DANGEROUS_PHRASE } from '@delorun/contract-setup-answers'
import { REACH_DEVICE } from '@delorun/home-auth'
import { dangerousGrantPath, readDangerousGrant } from '@delorun/plugin-permission-defaults/store'
import { DANGEROUS_WARNING_LINES, readPatchRow, readReachRowAt, REACH_OFF, TRUST_STATEMENT, writeReachRowAt } from '@delorun/setup-apply'
import { faceWorld, type FaceWorld } from '../../plugin-changes/tests/face-world.ts'
import { fakeTailscale, type FakeTailscale } from '../../reach/tests/fake-tailscale.ts'
import { MAX_RUN_REQUEST_BYTES, RUN_ROUTES } from '../src/client/run-settings-api.ts'
import { CONFIRMATION_MS, registerRunRoutes, RunSettings, type RunDependencies, type RunReach } from '../src/run-settings.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const HOST = 'my-pc.example.ts.net'
const START = Date.UTC(2026, 10, 22, 12, 0, 0)

interface Options {
  readonly record?: object | false
  readonly patch?: string
  readonly runningPort?: number
  readonly busy?: readonly number[]
  readonly root?: boolean
  readonly tailscale?: FakeTailscale
  readonly applied?: boolean
  /** Whether the hot-reload service is mounted; true unless a spec says otherwise. */
  readonly hotReload?: boolean
}

/** A temporary home and profile, and a service over them with its dependencies faked. */
function world(options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'delorun-run-settings-'))
  roots.push(home)
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  const record = options.record === undefined ? { version: 1, prompts: 'safer', background: true, profile: { name: null, port: null } } : options.record
  if (record !== false) writeFileSync(join(profileDir, 'setup-answers.json'), JSON.stringify(record))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), options.patch ?? '[]\n')
  let now = START
  let codes = 0
  const tailscale = options.tailscale ?? fakeTailscale(HOST)
  const applied: unknown[] = []
  const reach: RunReach = {
    mounted: true,
    apply: async (rows) => {
      applied.push(rows)
      return options.applied === false ? undefined : [{ option: 'tailscale-private', state: 'ready' }] as never
    },
  }
  const dependencies: RunDependencies = {
    where: () => ({ profile: 'default', profileDir, homeDir: home }),
    runningPort: () => options.runningPort,
    reach: () => reach,
    hotReload: () => options.hotReload !== false,
    isPortFree: async port => !(options.busy ?? []).includes(port),
    tailscale: tailscale.run,
    now: () => now,
    newCode: () => `code-${String((codes += 1))}`,
    runsAsRoot: () => options.root === true,
    locked: (_dir, run) => run(),
  }
  const service = new RunSettings(dependencies)
  const files = {
    row: (id: string): Readonly<Record<string, unknown>> | undefined => readPatchRow(join(profileDir, 'cordis.patch.yml'), id, 'test'),
    patchText: (): string => readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'),
    record: (): Record<string, unknown> => JSON.parse(readFileSync(join(profileDir, 'setup-answers.json'), 'utf8')) as Record<string, unknown>,
    recordText: (): string => readFileSync(join(profileDir, 'setup-answers.json'), 'utf8'),
    grant: async () => (await readDangerousGrant(dangerousGrantPath(home))).kind,
    grantPath: dangerousGrantPath(home),
  }
  return { service, files, home, profileDir, tailscale, applied, advance: (ms: number) => { now += ms }, dependencies }
}

/**
 * @param call - a call that is expected to be refused.
 * @returns the refusal's code, or undefined when the call did not throw one.
 */
function codeOfThrown(call: () => unknown): string | undefined {
  try {
    call()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('the state', () => {
  it('reports the recorded answers, the chosen and running ports and whether phone access is on', async () => {
    const { service } = world({ runningPort: 3081, patch: '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 3081\n' })
    expect(await service.state()).toEqual({
      recorded: true, prompts: 'safer', dangerous: 'off', background: true, port: { chosen: 3081, running: 3081 }, reach: { on: false, address: '' },
    })
  })

  it('reads setup\'s defaults for a profile without a record, and says it has none', async () => {
    const { service } = world({ record: false })
    expect(await service.state()).toMatchObject({ recorded: false, prompts: 'safer', background: true, port: { chosen: 3080, running: null } })
  })

  it('tells dangerous mode that holds from the answer without its grant file', async () => {
    const { service, files } = world({ record: { version: 1, prompts: 'dangerous' } })
    expect((await service.state()).dangerous).toBe('inactive')
    await service.dangerousBegin()
    await service.dangerousConfirm({ nonce: 'code-1', understood: true, phrase: DANGEROUS_PHRASE })
    expect((await service.state()).dangerous).toBe('on')
    expect(await files.grant()).toBe('valid')
  })
})

describe('how much Delorun asks', () => {
  it('writes the rows, then the record, and removes a dangerous-mode grant', async () => {
    const { service, files } = world({ record: { version: 1, prompts: 'dangerous', background: true } })
    await service.dangerousBegin()
    await service.dangerousConfirm({ nonce: 'code-1', understood: true, phrase: DANGEROUS_PHRASE })
    expect(await files.grant()).toBe('valid')
    expect(await service.prompts('stock')).toEqual({ prompts: 'stock', restartNeeded: false })
    expect(await files.grant()).toBe('absent')
    expect(files.record()).toMatchObject({ prompts: 'stock', background: true })
    expect(files.row('delorun-permission-defaults')).toMatchObject({ fullAccessEverywhere: false })
    expect(files.row('delorun-mcp-consent')).toEqual({ enabled: false })
  })

  it('says a restart is needed when no hot-reload service is mounted, because the rows reach plugins only at the next start', async () => {
    const { service, files } = world({ record: { version: 1, prompts: 'stock' }, hotReload: false })
    expect(await service.prompts('safer')).toEqual({ prompts: 'safer', restartNeeded: true })
    expect(files.row('delorun-mcp-consent')).toEqual({ enabled: true })
  })

  it('says no restart is needed when the hot-reload service is mounted', async () => {
    const { service } = world({ record: { version: 1, prompts: 'stock' }, hotReload: true })
    expect(await service.prompts('safer')).toEqual({ prompts: 'safer', restartNeeded: false })
  })

  it('writes Delorun\'s own answer for safer', async () => {
    const { service, files } = world({ record: { version: 1, prompts: 'stock' } })
    await service.prompts('safer')
    expect(files.record().prompts).toBe('safer')
    expect(files.row('delorun-mcp-consent')).toEqual({ enabled: true })
  })

  it('refuses a profile with no answers record, writing nothing', async () => {
    // Pins `recorded`: without it a profile that never ran setup would get an answers file only these routes wrote.
    const { service, files, profileDir } = world({ record: false })
    await expect(service.prompts('stock')).rejects.toMatchObject({ code: 'NOT_SET_UP' })
    expect(files.patchText()).toBe('[]\n')
    expect(existsSync(join(profileDir, 'setup-answers.json'))).toBe(false)
  })
})

describe('turning dangerous mode on', () => {
  const confirm = { nonce: 'code-1', understood: true, phrase: DANGEROUS_PHRASE } as const

  /** Everything a refused confirmation must leave as it was. */
  async function untouched(w: ReturnType<typeof world>): Promise<void> {
    expect(w.files.patchText()).toBe('[]\n')
    expect(w.files.record().prompts).toBe('safer')
    expect(await w.files.grant()).toBe('absent')
  }

  it('answers the warning, a single-use code and its time without changing anything', async () => {
    const w = world()
    expect(w.service.dangerousBegin()).toEqual({ warning: DANGEROUS_WARNING_LINES, nonce: 'code-1', expiresAt: START + CONFIRMATION_MS, phrase: DANGEROUS_PHRASE })
    await untouched(w)
  })

  it('writes the rows, the grant file and the record once the code, the yes and the phrase all hold', async () => {
    const w = world()
    w.service.dangerousBegin()
    expect(await w.service.dangerousConfirm(confirm)).toEqual({ dangerous: 'on', restartNeeded: false })
    expect(await w.files.grant()).toBe('valid')
    expect(w.files.record().prompts).toBe('dangerous')
    expect(w.files.row('delorun-permission-defaults')).toMatchObject({ fullAccessEverywhere: true })
  })

  it('refuses a wrong phrase, a phrase with other case or spaces, and an empty one, writing nothing', async () => {
    // Pins the typed phrase: without the comparison the server would trust the page's own check.
    for (const phrase of ['', 'full access', DANGEROUS_PHRASE.toUpperCase(), ` ${DANGEROUS_PHRASE}`, `${DANGEROUS_PHRASE} `]) {
      const w = world()
      w.service.dangerousBegin()
      await expect(w.service.dangerousConfirm({ ...confirm, phrase }), phrase).rejects.toMatchObject({ code: 'PHRASE_WRONG' })
      await untouched(w)
    }
  })

  it('refuses a yes that is not given', async () => {
    // Pins `understood`: the first confirmation of the person is a yes, and No is the page's start.
    const w = world()
    w.service.dangerousBegin()
    await expect(w.service.dangerousConfirm({ ...confirm, understood: false })).rejects.toMatchObject({ code: 'NOT_CONFIRMED' })
    await untouched(w)
  })

  it('refuses a confirmation with no begin, a wrong code, a code that ran out and a code used already', async () => {
    // Pins the code: without it any call that names the phrase would turn the mode on.
    const none = world()
    await expect(none.service.dangerousConfirm(confirm)).rejects.toMatchObject({ code: 'CODE_EXPIRED' })
    await untouched(none)
    const wrong = world()
    wrong.service.dangerousBegin()
    await expect(wrong.service.dangerousConfirm({ ...confirm, nonce: 'code-2' })).rejects.toMatchObject({ code: 'CODE_EXPIRED' })
    await untouched(wrong)
    const late = world()
    late.service.dangerousBegin()
    late.advance(CONFIRMATION_MS + 1)
    await expect(late.service.dangerousConfirm(confirm)).rejects.toMatchObject({ code: 'CODE_EXPIRED' })
    await untouched(late)
    const replayed = world()
    replayed.service.dangerousBegin()
    await expect(replayed.service.dangerousConfirm({ ...confirm, phrase: 'wrong' })).rejects.toMatchObject({ code: 'PHRASE_WRONG' })
    await expect(replayed.service.dangerousConfirm(confirm)).rejects.toMatchObject({ code: 'CODE_EXPIRED' })
    await untouched(replayed)
  })

  it('spends the code on a confirmation that says no, so a valid one afterwards is refused', async () => {
    // Pins the order in `dangerousConfirm`: a code that survived a refused call could be tried again with the right phrase.
    const w = world()
    w.service.dangerousBegin()
    await expect(w.service.dangerousConfirm({ ...confirm, understood: false })).rejects.toMatchObject({ code: 'NOT_CONFIRMED' })
    await expect(w.service.dangerousConfirm(confirm)).rejects.toMatchObject({ code: 'CODE_EXPIRED' })
    await untouched(w)
  })

  it('answers two confirmations with the same code at once with exactly one success', async () => {
    // Pins the code being cleared before the first await: two calls that both saw it would both write.
    const w = world()
    w.service.dangerousBegin()
    const results = await Promise.allSettled([w.service.dangerousConfirm(confirm), w.service.dangerousConfirm(confirm)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected').map(result => (result.reason as { code: string }).code)).toEqual(['CODE_EXPIRED'])
    expect(await w.files.grant()).toBe('valid')
  })

  it('lets a later begin replace the earlier code', async () => {
    const w = world()
    w.service.dangerousBegin()
    w.service.dangerousBegin()
    await expect(w.service.dangerousConfirm(confirm)).rejects.toMatchObject({ code: 'CODE_EXPIRED' })
    await untouched(w)
  })

  it('refuses a root user at both steps', async () => {
    // Pins `refuseRoot`: full access then reaches the whole computer.
    const w = world({ root: true })
    expect(codeOfThrown(() => w.service.dangerousBegin())).toBe('ROOT_REFUSED')
    await expect(w.service.dangerousConfirm(confirm)).rejects.toMatchObject({ code: 'ROOT_REFUSED' })
    await untouched(w)
  })

  it('refuses a profile with no answers record at both steps', async () => {
    const w = world({ record: false })
    expect(codeOfThrown(() => w.service.dangerousBegin())).toBe('NOT_SET_UP')
    await expect(w.service.dangerousConfirm(confirm)).rejects.toMatchObject({ code: 'CODE_EXPIRED' })
    expect(await w.files.grant()).toBe('absent')
  })

  it('says a restart is needed for dangerous mode when no hot-reload service is mounted', async () => {
    const w = world({ hotReload: false })
    w.service.dangerousBegin()
    expect(await w.service.dangerousConfirm(confirm)).toEqual({ dangerous: 'on', restartNeeded: true })
  })

  it('changes nothing when dangerous mode already holds with a valid grant', async () => {
    const w = world()
    w.service.dangerousBegin()
    await w.service.dangerousConfirm(confirm)
    const grant = readFileSync(w.files.grantPath, 'utf8')
    const record = w.files.recordText()
    w.advance(60_000)
    w.service.dangerousBegin()
    expect(await w.service.dangerousConfirm({ ...confirm, nonce: 'code-2' })).toEqual({ dangerous: 'on', restartNeeded: false })
    expect(readFileSync(w.files.grantPath, 'utf8')).toBe(grant)
    expect(w.files.recordText()).toBe(record)
  })
})

describe('running in the background', () => {
  it('records the answer and keeps every other key of the record', async () => {
    const w = world()
    expect(await w.service.background(false)).toEqual({ background: false, restartNeeded: false })
    expect(w.files.record()).toEqual({ version: 1, prompts: 'safer', background: false, profile: { name: null, port: null } })
  })

  it('refuses a profile with no answers record', async () => {
    const w = world({ record: false })
    await expect(w.service.background(false)).rejects.toMatchObject({ code: 'NOT_SET_UP' })
  })
})

describe('the studio port', () => {
  it('writes the web server row and the record, and says a restart is needed with the new address', async () => {
    const w = world({ runningPort: 3080 })
    expect(await w.service.port(4100)).toEqual({ port: 4100, origin: 'http://127.0.0.1:4100', restartNeeded: true })
    expect(w.files.row('webserver')).toEqual({ host: '127.0.0.1', port: 4100, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 })
    expect(w.files.record()).toMatchObject({ profile: { name: null, port: 4100 } })
  })

  it('records null for the default port, as setup does', async () => {
    const w = world({ patch: '- id: webserver\n  config:\n    port: 4100\n', record: { version: 1, prompts: 'safer', profile: { name: null, port: 4100 } } })
    await w.service.port(3080)
    expect(w.files.record()).toMatchObject({ profile: { port: null } })
  })

  it('refuses the port the studio uses now, the one it has chosen, and a busy port, writing nothing', async () => {
    // Pins `isPortFree` and the equality checks: the studio would fail to start on a port that is not free.
    const w = world({ runningPort: 3085, busy: [4000], patch: '- id: webserver\n  config:\n    port: 3090\n' })
    const patch = w.files.patchText()
    const record = w.files.recordText()
    await expect(w.service.port(3085)).rejects.toMatchObject({ code: 'PORT_UNCHANGED' })
    await expect(w.service.port(3090)).rejects.toMatchObject({ code: 'PORT_UNCHANGED' })
    await expect(w.service.port(4000)).rejects.toMatchObject({ code: 'PORT_BUSY' })
    expect(w.files.patchText()).toBe(patch)
    expect(w.files.recordText()).toBe(record)
  })

  it('refuses a profile with no answers record', async () => {
    const w = world({ record: false })
    await expect(w.service.port(4100)).rejects.toMatchObject({ code: 'NOT_SET_UP' })
  })
})

describe('phone access', () => {
  it('shows the private address and the trust statement, and issues a ticket, changing nothing', async () => {
    const w = world()
    const preview = await w.service.reachPreview()
    expect(preview).toEqual({ address: `https://${HOST}`, trust: TRUST_STATEMENT, ticket: 'code-1', expiresAt: START + CONFIRMATION_MS })
    expect(w.files.patchText()).toBe('[]\n')
    expect(w.tailscale.calls.some(call => call[0] === 'serve' && call.includes('--bg'))).toBe(false)
    expect(w.applied).toEqual([])
  })

  it('turns on with the ticket: it checks serve access, writes the row and the pairing default, and applies the rows', async () => {
    const w = world({ patch: '- id: delorun-home-auth\n  config:\n    pairing:\n      mayAskWithoutWindow: tailnet\n' })
    const { ticket } = await w.service.reachPreview()
    expect(await w.service.reach({ on: true, ticket })).toEqual({ on: true, address: `https://${HOST}`, ready: true, restartNeeded: false })
    const row = w.files.row('delorun-reach')
    expect(row).toMatchObject({ enabled: true, tailscalePrivate: { enabled: true, address: `https://${HOST}`, servePort: 443 } })
    expect((row?.['tailscalePrivate'] as { listenerPort: number }).listenerPort).toBeGreaterThan(0)
    expect(w.files.row('delorun-home-auth')).toMatchObject({ pairing: { mayAskWithoutWindow: 'own-user' } })
    expect(w.applied).toHaveLength(1)
  })

  it('refuses no ticket, a wrong ticket, a ticket used already and one that ran out, writing nothing and not touching Tailscale', async () => {
    // Pins the ticket: without it a call that skips the preview would change Tailscale unasked.
    const none = world()
    await expect(none.service.reach({ on: true, ticket: 'x' })).rejects.toMatchObject({ code: 'TICKET_INVALID' })
    const wrong = world()
    await wrong.service.reachPreview()
    await expect(wrong.service.reach({ on: true, ticket: 'code-2' })).rejects.toMatchObject({ code: 'TICKET_INVALID' })
    const late = world()
    const { ticket: lateTicket } = await late.service.reachPreview()
    late.advance(CONFIRMATION_MS + 1)
    await expect(late.service.reach({ on: true, ticket: lateTicket })).rejects.toMatchObject({ code: 'TICKET_INVALID' })
    const used = world()
    const { ticket } = await used.service.reachPreview()
    await used.service.reach({ on: true, ticket })
    const before = used.files.patchText()
    await expect(used.service.reach({ on: true, ticket })).rejects.toMatchObject({ code: 'TICKET_INVALID' })
    expect(used.files.patchText()).toBe(before)
    for (const refused of [none, wrong, late]) {
      expect(refused.files.patchText()).toBe('[]\n')
      expect(refused.tailscale.calls.filter(call => call[0] === 'serve' && call.includes('--bg'))).toEqual([])
      expect(refused.applied).toEqual([])
    }
  })

  it('refuses a ticket issued for another Tailscale name', async () => {
    const tailscale = fakeTailscale(HOST)
    const w = world({ tailscale })
    const { ticket } = await w.service.reachPreview()
    tailscale.answers.status = { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'other-pc.example.ts.net.' }, CertDomains: ['other-pc.example.ts.net'] }), stderr: '' }
    await expect(w.service.reach({ on: true, ticket })).rejects.toMatchObject({ code: 'TICKET_INVALID' })
    expect(w.files.patchText()).toBe('[]\n')
  })

  it('writes nothing when the Tailscale check fails, and says what to fix', async () => {
    // Pins the order: the serve access check runs before the row is written.
    const tailscale = fakeTailscale(HOST, { 'serve set': { code: 1, stdout: '', stderr: 'Access denied: serve config denied\nuse `sudo tailscale set --operator=$USER`' } })
    const w = world({ tailscale })
    const { ticket } = await w.service.reachPreview()
    await expect(w.service.reach({ on: true, ticket })).rejects.toMatchObject({ code: 'TAILSCALE_UNAVAILABLE', message: expect.stringContaining('Phone access stays off') })
    expect(w.files.patchText()).toBe('[]\n')
    expect(w.applied).toEqual([])
  })

  it('answers that Tailscale is not usable when the preview cannot read it', async () => {
    const w = world({ tailscale: fakeTailscale(HOST, { status: { code: null, stdout: '', stderr: '' } }) })
    await expect(w.service.reachPreview()).rejects.toMatchObject({ code: 'TAILSCALE_UNAVAILABLE' })
  })

  it('refuses a profile with no answers record at the preview and at both directions', async () => {
    const w = world({ record: false })
    await expect(w.service.reachPreview()).rejects.toMatchObject({ code: 'NOT_SET_UP' })
    await expect(w.service.reach({ on: true, ticket: 'code-1' })).rejects.toMatchObject({ code: 'NOT_SET_UP' })
    await expect(w.service.reach({ on: false })).rejects.toMatchObject({ code: 'NOT_SET_UP' })
    expect(w.files.patchText()).toBe('[]\n')
  })

  it('turns off: it writes the row off, removes Tailscale\'s serve rule and applies the rows', async () => {
    const w = world()
    const { ticket } = await w.service.reachPreview()
    await w.service.reach({ on: true, ticket })
    const answer = await w.service.reach({ on: false })
    expect(answer).toEqual({ on: false, address: '', ready: false, restartNeeded: false })
    expect(w.files.row('delorun-reach')).toMatchObject({ tailscalePrivate: { enabled: false } })
    expect(w.tailscale.calls.some(call => call[0] === 'serve' && call.includes('off'))).toBe(true)
    expect(w.applied).toHaveLength(2)
  })

  it('keeps a change made to the phone-access row while the checks ran, because it reads the row under the write lock', async () => {
    // Pins the read inside `locked`: a row read before the checks would write its stale fields over the change.
    const tailscale = fakeTailscale(HOST)
    let changed = false
    const w = world({ tailscale: { ...tailscale, run: async (args) => {
      if (!changed) {
        changed = true
        const path = join(w.profileDir, 'cordis.patch.yml')
        writeReachRowAt(path, { ...readReachRowAt(path), serveCheckIntervalMs: 12_345 })
      }
      return tailscale.run(args)
    } } })
    const { ticket } = await w.service.reachPreview()
    expect(await w.service.reach({ on: true, ticket })).toMatchObject({ on: true })
    expect(w.files.row('delorun-reach')).toMatchObject({ tailscalePrivate: { enabled: true, serveCheckIntervalMs: 12_345 } })
  })

  it('says a restart is needed when the running home cannot apply the rows', async () => {
    const w = world({ applied: false })
    const { ticket } = await w.service.reachPreview()
    expect(await w.service.reach({ on: true, ticket })).toMatchObject({ on: true, ready: false, restartNeeded: true })
  })
})

describe('the routes', () => {
  /** The studio's own origin on the loopback listener. */
  const STUDIO = { host: '127.0.0.1:4500', origin: 'http://127.0.0.1:4500', 'sec-fetch-site': 'same-origin' }
  const COMPUTER_ONLY = [RUN_ROUTES.dangerousBegin, RUN_ROUTES.dangerousConfirm, RUN_ROUTES.port, RUN_ROUTES.reachPreview, RUN_ROUTES.reach]
  const WRITES = [RUN_ROUTES.prompts, RUN_ROUTES.background, ...COMPUTER_ONLY]

  type Hook = (request: object, response: ServerResponse, next: () => Promise<void>) => Promise<void>
  interface Route { readonly path: string, readonly methods?: readonly string[], readonly admitPeer?: (request: Request, peer: object) => boolean, readonly fetch: (request: Request) => Promise<Response> }

  /** The routes over a service, on a fake Connection whose `homeAuth` places every request on one listener. */
  function routesOver(w: ReturnType<typeof world>, listener: string | undefined, face: FaceWorld = faceWorld('phone', 'reach-tailscale-private')) {
    let hook: Hook | undefined
    const routes = new Map<string, Route>()
    const ctx = {
      on: (_name: string, registered: Hook) => { hook = registered },
      get: (name: string) => (name === 'homeAuth' ? {
        ...face.fields, arrivalOf: () => ({ listener }), elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'e' } : undefined),
        pageUnlockOf: () => undefined, dangerousMode: () => true, unlockModeEnabled: () => false, touchUnlock: () => {},
      } : undefined),
      connection: { fetch: { register: (route: Route) => { routes.set(route.path, route) } } },
    }
    registerRunRoutes(ctx as never, w.service)
    const phone = (extra: object = {}): object => ({ principal: { kind: REACH_DEVICE, deviceId: 'phone', listener: 'reach-tailscale-private', ...extra } })
    return {
      routes,
      hook: (request: object, response: ServerResponse, next: () => Promise<void>) => hook!(request, response, next),
      /** Send a request as the computer's own studio: past the Connection's peer gate, which owners always pass. */
      studio: (path: string, body: string, method = 'POST') => routes.get(path)!.fetch(new Request(`http://localhost${path}`, { method, ...method === 'GET' ? {} : { body } })),
      /** Run one request as a device: admit the peer, then answer it. */
      device: async (path: string, body: string, grant?: string, extra: object = {}): Promise<Response> => {
        const route = routes.get(path)!
        const request = new Request(`http://localhost${path}`, { method: route.methods?.[0] ?? 'POST', headers: grant === undefined ? {} : { 'delorun-grant': grant }, ...route.methods?.[0] === 'GET' ? {} : { body } })
        if (route.admitPeer?.(request, phone(extra)) !== true) return new Response('forbidden', { status: 403 })
        return route.fetch(request)
      },
      face,
    }
  }

  /** Send a request through the hook and report whether it reached the route, and the refusal it was answered with. */
  async function through(routes: { hook: Hook }, request: { url: string, headers: Record<string, string> }): Promise<{ reached: boolean, status?: number, body?: Record<string, unknown> }> {
    const answered: { status?: number, body?: string } = {}
    const response = { writeHead: (status: number) => { answered.status = status }, end: (body: string) => { answered.body = body } }
    let reached = false
    await routes.hook(request, response as never, async () => { reached = true })
    return { reached, ...answered.status === undefined ? {} : { status: answered.status }, ...answered.body === undefined ? {} : { body: JSON.parse(answered.body) as Record<string, unknown> } }
  }

  it('refuse a reach session on every computer-only route, an unlocked device and dangerous mode included', async () => {
    // Pins `requireComputer` on the hook: a device that skipped it would reach dangerous mode and phone access.
    const w = world()
    const routes = routesOver(w, 'reach-tailscale-private')
    for (const path of COMPUTER_ONLY) {
      expect(await through(routes, { url: path, headers: { host: 'home.example.ts.net', origin: 'https://home.example.ts.net' } }), path).toMatchObject({ reached: false, status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
      // The route itself admits no device: the Connection refuses one before the route runs.
      expect(routes.routes.get(path)?.admitPeer, path).toBeUndefined()
    }
  })

  it('refuse a request the home cannot place, a rebinding Host and the spellings of the target', async () => {
    const unplaced = routesOver(world(), undefined)
    for (const path of COMPUTER_ONLY) expect(await through(unplaced, { url: path, headers: STUDIO })).toMatchObject({ reached: false, status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    const rebound = routesOver(world(), 'loopback')
    // The three routes a device may use are refused a foreign Host on the loopback listener too: a rebinding page could otherwise read the state.
    for (const path of [...COMPUTER_ONLY, RUN_ROUTES.state, RUN_ROUTES.prompts, RUN_ROUTES.background]) expect(await through(rebound, { url: path, headers: { host: 'attacker.example:4500', origin: 'http://attacker.example:4500' } }), path).toMatchObject({ reached: false, status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    for (const url of ['/api/x/../delorunRun.dangerousConfirm', '/api/%2e%2e/api/delorunRun.port', '/api\\delorunRun.reach?x=1']) {
      expect(await through(rebound, { url, headers: { host: 'home.example.ts.net' } })).toMatchObject({ reached: false, status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    }
  })

  it('refuse a request from another origin, a foreign fetch site or a sandboxed frame, on every route that changes anything', async () => {
    // Pins `fromStudioPage`: a page on another origin must not drive the computer's own studio.
    const atComputer = routesOver(world(), 'loopback')
    for (const path of WRITES) {
      for (const headers of [{ ...STUDIO, origin: 'https://evil.example' }, { ...STUDIO, origin: 'null' }, { ...STUDIO, 'sec-fetch-site': 'cross-site' }, { ...STUDIO, 'sec-fetch-site': 'same-site' }]) {
        expect(await through(atComputer, { url: path, headers }), `${path} ${JSON.stringify(headers)}`).toMatchObject({ reached: false, status: 403, body: { error: 'FOREIGN_ORIGIN' } })
      }
    }
    const reach = routesOver(world(), 'reach-tailscale-private')
    for (const path of [RUN_ROUTES.prompts, RUN_ROUTES.background]) {
      for (const headers of [{ host: 'home.example.ts.net', origin: 'https://evil.example' }, { host: 'home.example.ts.net', 'sec-fetch-site': 'cross-site' }]) {
        expect(await through(reach, { url: path, headers }), path).toMatchObject({ reached: false, status: 403, body: { error: 'FOREIGN_ORIGIN' } })
      }
    }
  })

  it('let the computer\'s own studio through to every route, and a reach session to the three a device may use', async () => {
    const atComputer = routesOver(world(), 'loopback')
    for (const path of [RUN_ROUTES.state, ...WRITES]) expect(await through(atComputer, { url: path, headers: STUDIO }), path).toEqual({ reached: true })
    const reach = routesOver(world(), 'reach-tailscale-private')
    for (const path of [RUN_ROUTES.state, RUN_ROUTES.prompts, RUN_ROUTES.background]) expect(await through(reach, { url: path, headers: { host: 'home.example.ts.net', origin: 'https://home.example.ts.net' } }), path).toEqual({ reached: true })
  })

  it('answer a body with an unknown field, a body that is not JSON and a body over the cap with 400, and change nothing', async () => {
    // Pins `z.strictObject` and the byte cap on every route.
    const w = world({ runningPort: 3080 })
    const routes = routesOver(w, 'loopback')
    const patch = w.files.patchText()
    const record = w.files.recordText()
    const valid: Readonly<Record<string, object>> = {
      [RUN_ROUTES.prompts]: { answer: 'stock' }, [RUN_ROUTES.background]: { on: false }, [RUN_ROUTES.dangerousBegin]: {},
      [RUN_ROUTES.dangerousConfirm]: { nonce: 'n', understood: true, phrase: DANGEROUS_PHRASE }, [RUN_ROUTES.port]: { port: 4100 },
      [RUN_ROUTES.reachPreview]: {}, [RUN_ROUTES.reach]: { on: false },
    }
    for (const path of WRITES) {
      for (const body of [JSON.stringify({ ...valid[path], extra: true }), 'not json', JSON.stringify({ ...valid[path], pad: 'x'.repeat(MAX_RUN_REQUEST_BYTES) })]) {
        const response = await routes.studio(path, body)
        expect([path, response.status, ((await response.json()) as { error: string }).error]).toEqual([path, 400, 'BAD_REQUEST'])
      }
    }
    expect(w.files.patchText()).toBe(patch)
    expect(w.files.recordText()).toBe(record)
    expect(await w.files.grant()).toBe('absent')
  })

  it('answer two confirmations of one code sent at once with exactly one 200', async () => {
    const w = world()
    const routes = routesOver(w, 'loopback')
    w.service.dangerousBegin()
    const body = JSON.stringify({ nonce: 'code-1', understood: true, phrase: DANGEROUS_PHRASE })
    const statuses = (await Promise.all([routes.studio(RUN_ROUTES.dangerousConfirm, body), routes.studio(RUN_ROUTES.dangerousConfirm, body)])).map(response => response.status)
    expect(statuses.sort()).toEqual([200, 409])
  })

  it('answer a port that is a string, below 1024, above 65535 or a fraction with 400, and write nothing', async () => {
    // Pins the port's schema: the page's own check is not the one that holds.
    const w = world()
    const routes = routesOver(w, 'loopback')
    for (const port of ['3080', 80, 1023, 65_536, 70_000, 4100.5, -1, null]) {
      const response = await routes.studio(RUN_ROUTES.port, JSON.stringify({ port }))
      expect([String(port), response.status]).toEqual([String(port), 400])
    }
    expect(w.files.patchText()).toBe('[]\n')
    expect((await routes.studio(RUN_ROUTES.port, JSON.stringify({ port: 4100 }))).status).toBe(200)
  })

  it('answer a body whose declared length is over the cap with 400 before reading it, and a stream that passes the cap with 400', async () => {
    // Pins `boundedBytes`: the cap holds on the length the request declares and on the bytes that arrive, not only on a buffered body.
    const w = world()
    const routes = routesOver(w, 'loopback')
    const record = w.files.recordText()
    const declared = await routes.routes.get(RUN_ROUTES.background)!.fetch(new Request(`http://localhost${RUN_ROUTES.background}`, { method: 'POST', body: '{"on":false}', headers: { 'content-length': String(MAX_RUN_REQUEST_BYTES + 1) } }))
    expect(declared.status).toBe(400)
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({ pull: (controller) => { pulled += 1; controller.enqueue(new Uint8Array(1024)) } })
    const streamed = await routes.routes.get(RUN_ROUTES.background)!.fetch(new Request(`http://localhost${RUN_ROUTES.background}`, { method: 'POST', body: endless, duplex: 'half' } as RequestInit))
    expect(streamed.status).toBe(400)
    expect(pulled).toBeLessThan(20)
    expect(w.files.recordText()).toBe(record)
  })

  it('answer a port web browsers block, or the one phone access listens on, with 400, and write nothing', async () => {
    // Pins `studioPortProblem` in the route: such a studio could not be opened in a browser after the restart.
    const w = world()
    writeReachRowAt(join(w.profileDir, 'cordis.patch.yml'), { ...REACH_OFF, listenerPort: 4500 })
    const routes = routesOver(w, 'loopback')
    const patch = w.files.patchText()
    const record = w.files.recordText()
    for (const port of [6000, 6665, 6666, 6667, 6668, 6669, 6697, 10_080, 4500]) {
      const response = await routes.studio(RUN_ROUTES.port, JSON.stringify({ port }))
      expect([port, response.status, ((await response.json()) as { error: string }).error]).toEqual([port, 400, 'BAD_REQUEST'])
    }
    expect(w.files.patchText()).toBe(patch)
    expect(w.files.recordText()).toBe(record)
    expect((await routes.studio(RUN_ROUTES.port, JSON.stringify({ port: 4100 }))).status).toBe(200)
  })

  it('answer turning phone access on without a ticket, or with a wrong type, with 400', async () => {
    const routes = routesOver(world(), 'loopback')
    for (const body of [{ on: true }, { on: 'yes' }, { on: false, ticket: 'x' }, {}]) expect((await routes.studio(RUN_ROUTES.reach, JSON.stringify(body))).status, JSON.stringify(body)).toBe(400)
  })

  it('answer a refused change with its code and status', async () => {
    const w = world({ record: false })
    const routes = routesOver(w, 'loopback')
    const response = await routes.studio(RUN_ROUTES.background, JSON.stringify({ on: false }), 'POST')
    expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([409, 'NOT_SET_UP'])
  })

  it('refuse a device the stock answer and the background with no grant, and leave the files as they were', async () => {
    // Pins `gateByClass` on both routes: a device that holds only an unlock, or none, must not turn questions off.
    const w = world()
    const routes = routesOver(w, 'reach-tailscale-private')
    const patch = w.files.patchText()
    const record = w.files.recordText()
    for (const unlock of [{}, { unlockId: 'live' }]) {
      for (const [path, body] of [[RUN_ROUTES.prompts, { answer: 'stock' }], [RUN_ROUTES.background, { on: false }]] as const) {
        const refused = await routes.device(path, JSON.stringify(body), undefined, unlock)
        expect([path, refused.status, ((await refused.json()) as { error: string }).error]).toEqual([path, 403, 'ELEVATION_REQUIRED'])
      }
    }
    expect(w.files.patchText()).toBe(patch)
    expect(w.files.recordText()).toBe(record)
  })

  it('answer any prompts value but safer and stock with 400 at the computer, and change nothing', async () => {
    // Pins `z.enum(['safer', 'stock'])`: widening it would turn dangerous mode on in one request, past the code and the phrase.
    const w = world()
    const routes = routesOver(w, 'loopback')
    const patch = w.files.patchText()
    const record = w.files.recordText()
    for (const answer of ['dangerous', 'DANGEROUS', ' safer', ['safer']]) {
      const response = await routes.studio(RUN_ROUTES.prompts, JSON.stringify({ answer }))
      expect([JSON.stringify(answer), response.status, ((await response.json()) as { error: string }).error]).toEqual([JSON.stringify(answer), 400, 'BAD_REQUEST'])
    }
    expect(w.files.patchText()).toBe(patch)
    expect(w.files.recordText()).toBe(record)
    expect(await w.files.grant()).toBe('absent')
  })

  it('answer the dangerous body 400 even to a device that holds a grant for exactly that body, and 403 to one that holds none', async () => {
    // Pins the enum behind the class gate: a grant admits the call, the route's schema still refuses the value.
    const w = world()
    const routes = routesOver(w, 'reach-tailscale-private')
    const patch = w.files.patchText()
    const record = w.files.recordText()
    const body = JSON.stringify({ answer: 'dangerous' })
    const grant = routes.face.grantFor('bundle-local/run-prompts', { path: RUN_ROUTES.prompts, body })
    expect((await routes.device(RUN_ROUTES.prompts, body, grant)).status).toBe(400)
    expect((await routes.device(RUN_ROUTES.prompts, body)).status).toBe(403)
    expect(w.files.patchText()).toBe(patch)
    expect(w.files.recordText()).toBe(record)
    expect(await w.files.grant()).toBe('absent')
  })

  it('send a body that names the key twice through the class gate, which answers a device with no grant 403', async () => {
    // Pins `saferOnly` reading the same value the route parses: the body is not read as `safer` by one and `stock` by the other.
    const w = world({ record: { version: 1, prompts: 'stock', background: true } })
    const routes = routesOver(w, 'reach-tailscale-private')
    const refused = await routes.device(RUN_ROUTES.prompts, '{"answer":"safer","answer":"stock"}')
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([403, 'ELEVATION_REQUIRED'])
    expect(w.files.record().prompts).toBe('stock')
    expect(w.files.row('delorun-mcp-consent')).toBeUndefined()
  })

  it('refuse a device without a PIN or a passkey the stock answer and the background', async () => {
    const w = world()
    const routes = routesOver(w, 'reach-tailscale-private', faceWorld('phone', 'reach-tailscale-private', false))
    for (const [path, body] of [[RUN_ROUTES.prompts, { answer: 'stock' }], [RUN_ROUTES.background, { on: false }]] as const) {
      const refused = await routes.device(path, JSON.stringify(body))
      expect([path, refused.status]).toEqual([path, 403])
    }
    expect(w.files.record()).toMatchObject({ prompts: 'safer', background: true })
  })

  it('admit exactly the body a grant was made for, once', async () => {
    // Pins the request hash and its single use.
    const w = world()
    const routes = routesOver(w, 'reach-tailscale-private')
    const body = JSON.stringify({ answer: 'stock' })
    const grant = routes.face.grantFor('bundle-local/run-prompts', { path: RUN_ROUTES.prompts, body })
    expect((await routes.device(RUN_ROUTES.prompts, JSON.stringify({ answer: 'stock', x: 1 }), grant)).status).toBe(403)
    expect(w.files.record().prompts).toBe('safer')
    expect((await routes.device(RUN_ROUTES.prompts, body, grant)).status).toBe(200)
    expect(w.files.record().prompts).toBe('stock')
    expect((await routes.device(RUN_ROUTES.prompts, body, grant)).status).toBe(403)
  })

  it('ask for the stock answer even during a Face ID pass, and let the background through one', async () => {
    // Pins PASS_ALWAYS_ASK for prompts and PASS_ADMITS for the background.
    const w = world()
    const face = faceWorld('phone', 'reach-tailscale-private')
    face.store.openPass({ deviceId: 'phone', listener: 'reach-tailscale-private' as never }, 60)
    const routes = routesOver(w, 'reach-tailscale-private', face)
    expect((await routes.device(RUN_ROUTES.prompts, JSON.stringify({ answer: 'stock' }))).status).toBe(403)
    expect(w.files.record().prompts).toBe('safer')
    expect((await routes.device(RUN_ROUTES.background, JSON.stringify({ on: false }))).status).toBe(200)
    expect(w.files.record().background).toBe(false)
  })

  it('let a device answer safer with no grant, because it only tightens, and read the state', async () => {
    const w = world({ record: { version: 1, prompts: 'stock', background: true } })
    const routes = routesOver(w, 'reach-tailscale-private')
    expect((await routes.device(RUN_ROUTES.prompts, JSON.stringify({ answer: 'safer' }))).status).toBe(200)
    expect(w.files.record().prompts).toBe('safer')
    const state = await routes.device(RUN_ROUTES.state, '')
    expect([state.status, await state.json()]).toEqual([200, expect.objectContaining({ prompts: 'safer' })])
  })

  it('never ask the computer for a grant: a request that skips the peer gate reaches the service', async () => {
    // Pins `principal === undefined` in the class gate: the owner's Peer is never asked.
    const w = world()
    const routes = routesOver(w, 'loopback')
    expect((await routes.studio(RUN_ROUTES.prompts, JSON.stringify({ answer: 'stock' }))).status).toBe(200)
    expect((await routes.studio(RUN_ROUTES.background, JSON.stringify({ on: false }))).status).toBe(200)
    expect(w.files.record()).toMatchObject({ prompts: 'stock', background: false })
  })

  it('does not reach the service for a request the hook refused', async () => {
    const w = world()
    const spy = vi.spyOn(w.service, 'dangerousBegin')
    const routes = routesOver(w, 'reach-tailscale-private')
    await through(routes, { url: RUN_ROUTES.dangerousBegin, headers: { host: 'home.example.ts.net' } })
    expect(spy).not.toHaveBeenCalled()
  })
})
