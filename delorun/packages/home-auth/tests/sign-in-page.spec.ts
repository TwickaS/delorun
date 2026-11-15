// @vitest-environment jsdom
/**
 * The sign-in page's script over the page's own markup: each state the device-side flow shows, the language and copy
 * tables, and the step each refusal leads to. The home is a fake `fetch`; the device key is a real P-256 key from
 * Node's WebCrypto, so the match code the page shows is the one C5 derives.
 */
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { MARK } from '@delorun/brand/mark'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- the sign-in page's browser module is JavaScript without declarations.
import { COPY, POLL_MS, VIEWS, defaultLabelOf, deviceIdOf, fill, landingOf, languageOf, matchCodeOf, start } from '../assets/sign-in.js'

const subtle = webcrypto.subtle
/**
 * The page's markup as the route serves it, read from the asset: under jsdom, Vite rewrites a source module's
 * `import.meta.url`, so `src/reach-routes.ts` cannot read its assets here. `reach-routes.spec.ts` pins the served page.
 */
const SIGN_IN_PAGE = readFileSync(fileURLToPath(import.meta.url).replace(/tests[\\/]sign-in-page\.spec\.ts$/, 'assets/sign-in.html'), 'utf8')
const ORIGIN = 'https://home.example.ts.net'
const HOME_KEY = 'aG9tZS1wdWJsaWMta2V5'
const HOME_NONCE = 'aG9tZS1ub25jZS0xMjM0NQ'
const DATE = 'Thu, 01 Jan 2026 00:00:00 GMT'
const en = COPY.en as Record<string, string>
const zh = COPY.zh as Record<string, string>

/** One answer of the fake home: a status and JSON value, or a request that never arrived. */
type Answer = { readonly status: number; readonly value?: unknown } | 'offline'

interface Call {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown> | undefined
  readonly headers: Record<string, string>
}

/** A fake home that answers each path from its own queue; the last answer of a queue repeats. */
class Home {
  readonly calls: Call[] = []
  private readonly queues = new Map<string, Answer[]>()

  answer(path: string, ...answers: Answer[]): this {
    this.queues.set(path, answers)
    return this
  }

  fetch = async (path: string, init: { method: string; body?: string; headers: Record<string, string> }): Promise<unknown> => {
    this.calls.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>, headers: init.headers })
    const queue = this.queues.get(path) ?? [{ status: 404, value: {} }]
    const answer = queue.length > 1 ? queue.shift() : queue[0]
    if (answer === undefined || answer === 'offline') throw new TypeError('Failed to fetch')
    return {
      status: answer.status,
      json: async () => {
        if (answer.value === undefined) throw new SyntaxError('no body')
        return answer.value
      },
      headers: { get: (name: string) => (name === 'date' ? DATE : null) },
    }
  }

  paths(): string[] {
    return this.calls.map(call => `${call.method} ${call.path}`)
  }
}

const TRUSTED = { status: 200, value: { challenge: 'Y2hhbGxlbmdl' } }
const UNTRUSTED = { status: 401, value: { error: 'DEVICE_NOT_TRUSTED', message: 'not trusted' } }
const SIGNED_IN = { status: 201, value: { sessionId: 's', expiresAt: 1 } }
const ACCEPTED = { status: 201, value: { requestId: 'r1', requestSecret: 'secret', homePublicKey: HOME_KEY, homeNonce: HOME_NONCE, expiresAt: Date.parse(DATE) + 300_000 } }
const STATE = (state: string): Answer => ({ status: 200, value: { state } })
const REFUSAL = (status: number, error: string): Answer => ({ status, value: { error, message: 'refused' } })
const STATE_PATH = '/auth/device/request/r1'

let pair: CryptoKeyPair

beforeEach(async () => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(SIGN_IN_PAGE)?.[1] ?? ''
  pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
})

afterEach(() => {
  document.body.innerHTML = ''
})

interface Run {
  readonly home: Home
  readonly opened: string[]
  readonly sleeps: number[]
  readonly clock: { now: number }
}

/** Start the page against a fake home. */
async function run(home: Home, options: { languages?: string[]; userAgent?: string; supported?: boolean; landing?: string; keys?: () => Promise<CryptoKeyPair> } = {}): Promise<Run> {
  const opened: string[] = []
  const sleeps: number[] = []
  const clock = { now: 0 }
  await start({
    document,
    host: 'home.example.ts.net',
    origin: ORIGIN,
    languages: options.languages ?? ['en-GB'],
    userAgent: options.userAgent ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    fetch: home.fetch,
    subtle,
    random: (size: number) => new Uint8Array(size).fill(9),
    keys: options.keys ?? (() => Promise.resolve(pair)),
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock.now += ms
    },
    now: () => clock.now,
    open: (path: string) => { opened.push(path) },
    landing: options.landing ?? '/',
    supported: options.supported ?? true,
  })
  return { home, opened, sleeps, clock }
}

const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`no #${id}`)
  return element
}
const view = (): string | undefined => document.querySelector<HTMLElement>('main[data-sign-in]')?.dataset.view
const title = (): string => byId('title').textContent
const visible = (id: string): boolean => !byId(id).hidden
/** Let the page's pending steps run. */
const settle = async (): Promise<void> => {
  // WebCrypto's digests and signatures finish off the main thread, so a few turns of the event loop pass.
  for (let index = 0; index < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 2))
}

/** Ask for approval from the request view and wait for the flow to stop. */
async function ask(name?: string): Promise<void> {
  if (name !== undefined) (byId('label') as HTMLInputElement).value = name
  byId('request-form').dispatchEvent(new Event('submit', { cancelable: true }))
  await settle()
}

describe('the page before the device is approved', () => {
  it('says the browser cannot sign in without WebCrypto and IndexedDB, and calls nothing', async () => {
    const home = new Home()
    await run(home, { supported: false })
    expect(view()).toBe('unsupported')
    expect(title()).toBe(en['unsupported.title'])
    expect(visible('request-form')).toBe(false)
    expect(visible('actions')).toBe(false)
    expect(home.calls).toEqual([])
  })

  it('says so too when no key can be made or kept', async () => {
    await run(new Home(), { keys: () => Promise.reject(new Error('DataCloneError')) })
    expect(view()).toBe('unsupported')
  })

  it('signs a trusted device straight in and opens the studio', async () => {
    const home = new Home().answer('/auth/device/challenge', TRUSTED).answer('/auth/session', SIGNED_IN)
    const { opened } = await run(home)
    expect(view()).toBe('returning')
    expect(opened).toEqual(['/'])
    const session = home.calls[1]?.body ?? {}
    expect(session.deviceId).toBe(await deviceIdOf(await subtle.exportKey('jwk', pair.publicKey), subtle))
    expect(session.challenge).toBe('Y2hhbGxlbmdl')
  })

  it('shows a new device the steps, the name field with a name for its platform, and the guide', async () => {
    await run(new Home().answer('/auth/device/challenge', UNTRUSTED))
    expect(view()).toBe('request')
    expect(title()).toBe(en['request.title'])
    expect(visible('steps') && visible('request-form')).toBe(true)
    expect(byId('steps').querySelector('code')?.textContent).toBe('delorun devices approve')
    expect((byId('label') as HTMLInputElement).value).toBe('iPhone')
    expect(byId('address').textContent).toBe('home.example.ts.net')
    expect(document.documentElement.lang).toBe('en')
    expect(document.title).toBe(en['document.title'])
    expect(byId('announce').textContent).toBe(`${en['request.title']} ${en['request.lead']}`)
    expect(document.activeElement).toBe(byId('title'))
  })

  it('speaks Chinese to a browser that prefers it', async () => {
    await run(new Home().answer('/auth/device/challenge', UNTRUSTED), { languages: ['zh-CN', 'en'], userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile' })
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(title()).toBe(zh['request.title'])
    expect(byId('submit').textContent).toBe(zh['request.submit'])
    expect((byId('label') as HTMLInputElement).value).toBe('Android 手机')
  })

  it('reports a home it cannot reach, and checks again on Try again', async () => {
    const home = new Home().answer('/auth/device/challenge', 'offline', TRUSTED).answer('/auth/session', SIGNED_IN)
    const { opened } = await run(home)
    expect(view()).toBe('offline')
    expect(byId('retry').textContent).toBe(en['action.tryAgain'])
    expect(visible('restart')).toBe(false)
    const guide = document.querySelector<HTMLAnchorElement>('footer a')
    guide?.focus()
    byId('retry').click()
    await settle()
    expect(opened).toEqual(['/'])
    expect(document.activeElement).toBe(guide)
  })

  it('reports a device with too many sign-ins, too many tries, and any other refusal with its code', async () => {
    await run(new Home().answer('/auth/device/challenge', TRUSTED).answer('/auth/session', REFUSAL(429, 'SESSION_LIMIT_REACHED')))
    expect(view()).toBe('sessions')
    expect(byId('lead').querySelector('strong')?.textContent).toBe('Settings → Devices')
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(SIGN_IN_PAGE)?.[1] ?? ''
    await run(new Home().answer('/auth/device/challenge', REFUSAL(429, 'APPROVAL_RATE_LIMITED')))
    expect(view()).toBe('rate-limited')
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(SIGN_IN_PAGE)?.[1] ?? ''
    await run(new Home().answer('/auth/device/challenge', REFUSAL(403, 'TAILNET_IDENTITY_UNAVAILABLE')))
    expect(view()).toBe('failed')
    expect(byId('detail').textContent).toBe('Error code: TAILNET_IDENTITY_UNAVAILABLE')
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(SIGN_IN_PAGE)?.[1] ?? ''
    await run(new Home().answer('/auth/device/challenge', { status: 502 }))
    expect(byId('detail').textContent).toBe('Error code: HTTP 502')
  })
})

describe('asking for approval', () => {
  const asking = (): Home => new Home().answer('/auth/device/challenge', UNTRUSTED, TRUSTED).answer('/auth/session', SIGNED_IN)

  it('shows the match code to type at the computer, waits, and signs in once approved', async () => {
    const home = asking().answer('/auth/device/request', ACCEPTED).answer(STATE_PATH, STATE('pending'), { status: 429, value: {} }, STATE('approved'))
    const page = await run(home)
    await ask(' Kitchen tablet ')
    const request = home.calls.find(call => call.path === '/auth/device/request')?.body ?? {}
    expect(request).toMatchObject({ v: 1, label: 'Kitchen tablet', deviceNonce: 'CQkJCQkJCQkJCQkJCQkJCQ' })
    const code = await matchCodeOf({ homePublicKey: HOME_KEY, deviceId: await deviceIdOf(await subtle.exportKey('jwk', pair.publicKey), subtle), homeNonce: HOME_NONCE, deviceNonce: 'CQkJCQkJCQkJCQkJCQkJCQ', address: ORIGIN }, subtle)
    expect(home.calls.filter(call => call.path === STATE_PATH).map(call => call.headers.authorization)).toEqual(['Delorun-Request secret', 'Delorun-Request secret', 'Delorun-Request secret'])
    expect(page.sleeps.every(ms => ms === POLL_MS)).toBe(true)
    expect(page.opened).toEqual(['/'])
    expect(view()).toBe('approved')
    expect(byId('code-first').textContent + byId('code-second').textContent).toBe(code)
    expect(byId('code-spoken').textContent).toBe(`Code: ${code.split('').join(' ')}`)
    expect(byId('help').querySelector('strong')?.textContent).toBe('Kitchen tablet')
  })

  it('counts the code down from the home clock while it waits', async () => {
    const home = asking().answer('/auth/device/request', ACCEPTED).answer(STATE_PATH, STATE('pending'), STATE('pending'), 'offline')
    const page = await run(home)
    await ask()
    expect(view()).toBe('expired')
    expect(page.clock.now).toBeGreaterThanOrEqual(300_000)
  })

  it('shows the code with its expiry, counted from the home clock, while the home says pending', async () => {
    const holds: (() => void)[] = []
    const clock = { now: 0 }
    const home = asking().answer('/auth/device/request', ACCEPTED).answer(STATE_PATH, STATE('pending'))
    void start({
      document, host: 'h', origin: ORIGIN, languages: ['en'], userAgent: 'x', fetch: home.fetch, subtle,
      random: (size: number) => new Uint8Array(size), keys: () => Promise.resolve(pair),
      sleep: () => new Promise<void>((resolve) => { holds.push(resolve) }), now: () => clock.now, open: () => undefined, landing: '/', supported: true,
    })
    await settle()
    await ask()
    expect(view()).toBe('waiting')
    expect(title()).toBe(en['waiting.title'])
    expect(byId('expiry').textContent).toBe('Expires in 5 minutes')
    expect(byId('announce').textContent).toMatch(/^Type this code at your computer Code: \d( \d){7}$/)
    clock.now = 250_000
    holds.shift()?.()
    await settle()
    expect(byId('expiry').textContent).toBe('Expires in 1 minute')
    expect(view()).toBe('waiting')
  })

  it('keeps waiting through a lost connection and says so', async () => {
    const home = asking().answer('/auth/device/request', ACCEPTED).answer(STATE_PATH, 'offline', STATE('cancelled'))
    await run(home)
    const notes: string[] = []
    const observer = new MutationObserver(() => { notes.push(byId('announce').textContent) })
    observer.observe(byId('announce'), { childList: true, characterData: true, subtree: true })
    await ask()
    observer.disconnect()
    expect(notes).toContain(en['waiting.reconnecting'])
    expect(view()).toBe('declined')
    expect(visible('note')).toBe(false)
  })

  for (const [state, expected] of [[STATE('cancelled'), 'declined'], [STATE('expired'), 'expired'], [REFUSAL(410, 'APPROVAL_EXPIRED'), 'expired'], [REFUSAL(500, 'INTERNAL_ERROR'), 'failed']] as const) {
    it(`ends the wait as ${expected} when the home answers ${JSON.stringify(state)}`, async () => {
      await run(asking().answer('/auth/device/request', ACCEPTED).answer(STATE_PATH, state))
      await ask()
      expect(view()).toBe(expected)
    })
  }

  for (const [error, status, expected] of [['APPROVALS_CLOSED', 403, 'closed'], ['APPROVAL_PENDING_LIMIT', 429, 'busy'], ['APPROVAL_RATE_LIMITED', 429, 'rate-limited'], ['NO_OWNER', 403, 'failed']] as const) {
    it(`leads ${error} to the ${expected} view, whose action asks again`, async () => {
      const home = asking().answer('/auth/device/request', REFUSAL(status, error), ACCEPTED).answer(STATE_PATH, STATE('cancelled'))
      await run(home)
      await ask()
      expect(view()).toBe(expected)
      expect(visible('retry') && visible('restart')).toBe(true)
      byId('retry').click()
      await settle()
      expect(home.calls.filter(call => call.path === '/auth/device/request')).toHaveLength(2)
      expect(view()).toBe('declined')
    })
  }

  it('reports a home lost while asking, and a sign-in refused after approval', async () => {
    await run(asking().answer('/auth/device/request', 'offline'))
    await ask()
    expect(view()).toBe('offline')
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(SIGN_IN_PAGE)?.[1] ?? ''
    const home = new Home().answer('/auth/device/challenge', UNTRUSTED, REFUSAL(401, 'CHALLENGE_INVALID')).answer('/auth/device/request', ACCEPTED).answer(STATE_PATH, STATE('approved'))
    const page = await run(home)
    await ask()
    expect(view()).toBe('failed')
    expect(page.opened).toEqual([])
  })

  it('refuses an empty name before calling, and shows a refused name on its field', async () => {
    const home = asking().answer('/auth/device/request', REFUSAL(400, 'BAD_REQUEST'))
    await run(home)
    await ask('   ')
    expect(home.calls.some(call => call.path === '/auth/device/request')).toBe(false)
    expect(byId('label-error').textContent).toBe(en['request.nameMissing'])
    expect(byId('label').getAttribute('aria-invalid')).toBe('true')
    expect(byId('label').getAttribute('aria-describedby')).toBe('label-hint label-error')
    byId('label').dispatchEvent(new Event('input'))
    expect(visible('label-error')).toBe(false)
    await ask('Phone‮')
    expect(view()).toBe('request')
    expect(byId('label-error').textContent).toBe(en['request.nameRefused'])
    expect(document.activeElement).toBe(byId('label'))
  })

  it('starts over from the code, and the abandoned wait changes nothing', async () => {
    let hold: () => void = () => undefined
    const home = asking().answer('/auth/device/request', ACCEPTED).answer(STATE_PATH, STATE('approved'))
    const opened: string[] = []
    void start({
      document, host: 'h', origin: ORIGIN, languages: ['en'], userAgent: 'x', fetch: home.fetch, subtle,
      random: (size: number) => new Uint8Array(size), keys: () => Promise.resolve(pair),
      sleep: () => new Promise<void>((resolve) => { hold = resolve }), now: () => 0, open: (path: string) => { opened.push(path) }, landing: '/', supported: true,
    })
    await settle()
    await ask()
    expect(view()).toBe('waiting')
    expect(visible('code-panel') && visible('restart') && !visible('retry')).toBe(true)
    byId('restart').focus()
    byId('restart').click()
    expect(view()).toBe('request')
    expect(document.activeElement).toBe(byId('title'))
    hold()
    await settle()
    expect(view()).toBe('request')
    expect(opened).toEqual([])
  })
})

describe('the header', () => {
  it('draws the Delorun mark beside the wordmark, decorative and within the page\'s own markup', () => {
    const header = new DOMParser().parseFromString(SIGN_IN_PAGE, 'text/html').querySelector('header.brand')
    const mark = header?.querySelector('svg.mark')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    expect(mark?.getAttribute('viewBox')).toBe('0 0 32 32')
    expect(mark?.querySelector('path')?.getAttribute('d')).toBe(MARK.nut)
    const plug = mark?.querySelector('circle')
    expect([plug?.getAttribute('cx'), plug?.getAttribute('cy'), plug?.getAttribute('r')]).toEqual([String(MARK.plug.cx), String(MARK.plug.cy), String(MARK.plug.r)])
    expect(header?.querySelector('.wordmark')?.textContent).toBe('Delorun')
    // The reach listener sends no CSP (reach-routes.spec.ts), and the mark needs no image request, style attribute or script.
    expect(mark?.outerHTML).not.toMatch(/\b(href|src|style|on\w+)=/)
  })
})

describe('the copy and views', () => {
  it('has every text in both languages, for every view and every slot of the markup', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of [...SIGN_IN_PAGE.matchAll(/data-copy="([^"]+)"/g)].map(match => match[1] ?? '')) expect(en).toHaveProperty([key])
    for (const name of Object.keys(VIEWS as object)) expect(en).toHaveProperty([`${name}.title`])
  })

  it('writes markup as elements and values as text', () => {
    const element = document.createElement('p')
    fill(element, 'Run `a {x}` on **{x}**, {missing}', { x: '**<b>**' })
    expect(element.innerHTML).toBe('Run <code>a **&lt;b&gt;**</code> on <strong>**&lt;b&gt;**</strong>, {missing}')
  })

  it('lands only on a path of this origin, and signs a device in to it', async () => {
    const origin = 'https://home.example.ts.net'
    expect(landingOf('?next=%2Fsession%2F7%3Fx%3D1', origin)).toBe('/session/7?x=1')
    for (const search of ['', '?next=https%3A%2F%2Fexample.com%2F', '?next=%2F%2Fexample.com', '?next=%2F%5Cexample.com', '?next=session'] as const) expect(landingOf(search, origin)).toBe('/')
    const home = new Home().answer('/auth/device/challenge', TRUSTED).answer('/auth/session', SIGNED_IN)
    expect((await run(home, { landing: '/session/7' })).opened).toEqual(['/session/7'])
  })

  it('picks the language and a name for the platform', () => {
    expect(languageOf(['fr-FR', 'zh-TW', 'en'])).toBe('zh')
    expect(languageOf(['fr-FR'])).toBe('en')
    expect(languageOf(['EN-us', 'zh'])).toBe('en')
    const names = ['iPad', 'Android 14; Tablet', 'CrOS', 'Macintosh', 'Windows NT 10.0', 'X11; Linux'].map(agent => defaultLabelOf(agent, COPY.en))
    expect(names).toEqual(['iPad', 'Android tablet', 'Chromebook', 'Mac', 'Windows PC', 'My device'])
    expect(defaultLabelOf('Android; Tablet', COPY.zh)).toBe('Android 平板')
    expect(defaultLabelOf('Windows', COPY.zh)).toBe('Windows 电脑')
  })
})
