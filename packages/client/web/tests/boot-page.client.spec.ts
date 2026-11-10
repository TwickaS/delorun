// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOT_WORDMARK_GLOBAL, BootPage, bootWordmark, RECOVERY_ROUTES_GLOBAL, recoveryRoutes, recoveryText } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('the boot wordmark', () => {
  it('shows the product a distribution names through the page global, and HARNESS otherwise', () => {
    expect(bootWordmark({ [BOOT_WORDMARK_GLOBAL]: 'Delo' })).toBe('Delo')
    for (const value of [undefined, '', '  ', 42, 'x'.repeat(41)]) expect(bootWordmark({ [BOOT_WORDMARK_GLOBAL]: value })).toBe('HARNESS')
    Reflect.set(globalThis, BOOT_WORDMARK_GLOBAL, 'Delo')
    try {
      const { el } = mount()
      expect(el.textContent).toContain('Delo')
      expect(el.textContent).not.toContain('HARNESS')
    } finally {
      Reflect.deleteProperty(globalThis, BOOT_WORDMARK_GLOBAL)
    }
  })
})

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.textContent).toContain('HARNESS')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('draws the loading skeleton again when a failed entry activates after all', () => {
    const { el, page } = mount()
    page.setState('a', 'failed')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    page.setState('a', 'active')
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })
})

describe('the recovery screen', () => {
  const ROUTES = '/delo/changes'
  const STATE = {
    atComputer: true,
    lastStart: { at: '2026-11-10T10:00:00.000Z', failure: 'plug-b failed to start', plugins: [{ plugin: 'plug-a', loaded: true }, { plugin: 'plug-b', loaded: false, error: 'TypeError: boom' }, { plugin: 'plug-c', loaded: false }, { loaded: true }] },
    leftOut: [{ id: 'c0000000001', summary: 'Edits plug-d', lastFailure: { failure: 'did not build' } }, { id: 'c0000000004', summary: 'Edits plug-e' }],
    recent: [{ id: 'c0000000002', summary: 'Applied <b>plug-b</b>', state: 'applied', undoable: true }, { id: 'c0000000003', summary: 'Turned off plug-z', state: 'undone' }, { summary: 'no id' }, { id: 'c0000000005' }],
    problems: ['The work session cannot be read: broken', 7],
  }

  type Answer = { status: number; body: unknown } | Error | string

  interface Options {
    state?: unknown
    stateStatus?: number
    answers?: Answer[]
    confirm?: boolean
    language?: string
  }

  /** A fetch that answers the state route with `state` and each action with the next answer. */
  function environment(options: Options = {}) {
    const posted: Array<{ url: string; body: unknown }> = []
    const answers = [...options.answers ?? []]
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body as string) })
        const answer = answers.shift() ?? { status: 200, body: {} }
        if (typeof answer === 'string' || answer instanceof Error) throw answer
        return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status })
      }
      const state = options.state ?? STATE
      return new Response(typeof state === 'string' ? state : JSON.stringify(state), { status: options.stateStatus ?? 200 })
    })
    const confirm = vi.fn(() => options.confirm ?? true)
    return { env: { fetch, confirm, language: options.language }, posted, fetch, confirm }
  }

  function mountRecovery(env: ConstructorParameters<typeof BootPage>[1]) {
    const el = document.createElement('div')
    document.body.append(el)
    const page = new BootPage(el, env)
    return { el, page }
  }

  function button(el: HTMLElement, label: string): HTMLButtonElement {
    const found = [...el.querySelectorAll('button')].find(candidate => candidate.getAttribute('aria-label')?.startsWith(label) === true || candidate.textContent === label)
    if (found === undefined) throw new Error(`no button ${label}`)
    return found
  }

  beforeEach(() => { Reflect.set(globalThis, RECOVERY_ROUTES_GLOBAL, ROUTES) })
  afterEach(() => { Reflect.deleteProperty(globalThis, RECOVERY_ROUTES_GLOBAL) })

  it('reads the routes the page names and nothing else', () => {
    expect(recoveryRoutes({ [RECOVERY_ROUTES_GLOBAL]: '/delo/changes' })).toBe('/delo/changes')
    for (const value of [undefined, '', 'delo', '/delo/', 'https://evil.example/x', '/a?b', 7]) expect(recoveryRoutes({ [RECOVERY_ROUTES_GLOBAL]: value })).toBeUndefined()
    expect(recoveryText('zh-CN').title).toBe('恢复')
    expect(recoveryText('en-GB').title).toBe('Recovery')
    expect(recoveryText(undefined).title).toBe('Recovery')
  })

  it('offers nothing on a page that names no recovery routes', () => {
    Reflect.deleteProperty(globalThis, RECOVERY_ROUTES_GLOBAL)
    const { env, fetch } = environment()
    const { el, page } = mountRecovery(env)
    expect(page.recover()).toBe(false)
    page.fail('boom')
    expect(el.querySelector('[data-dsh-recovery]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows what failed, the plugins, the recent changes and safe mode, every string as text', async () => {
    const { env, fetch } = environment()
    const { el, page } = mountRecovery(env)
    expect(page.recover()).toBe(true)
    const screen = el.querySelector<HTMLElement>('[data-dsh-recovery]')!
    expect(screen.lang).toBe('en')
    expect(document.activeElement?.textContent).toBe('Recovery')
    await vi.waitFor(() => { expect(screen.textContent).toContain('Recent changes') })
    expect(fetch).toHaveBeenCalledWith('/delo/changes/state')
    for (const line of ['c0000000005 ()', 'plug-b failed to start', 'plug-b: TypeError: boom', 'plug-c: did not load', 'Edits plug-d: did not build', 'Edits plug-e: did not load', 'The work session cannot be read: broken', 'Applied <b>plug-b</b> (applied)', 'Turned off plug-z (undone)', 'Start in safe mode']) {
      expect(screen.textContent).toContain(line)
    }
    expect(screen.querySelector('b')).toBeNull()
    expect(screen.textContent).not.toContain('This needs you at your computer.')
    expect([...screen.querySelectorAll('button')].map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Turn off: plug-a', 'Turn off: plug-b', 'Turn off: plug-c', 'Undo: Applied <b>plug-b</b> (applied)', 'Start in safe mode'])
    expect(screen.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite')
    // A later failure keeps the same screen below the report.
    page.setState('broken-plugin', 'failed')
    expect(el.textContent).toContain('Failed to load plugins')
    expect(el.querySelectorAll('[data-dsh-recovery]')).toHaveLength(1)
  })

  it('shows an empty state and safe mode that is already on, in Chinese', async () => {
    const { env } = environment({ state: { atComputer: true, recent: [], safeMode: { since: '2026-11-10T09:00:00.000Z' } }, language: 'zh-CN' })
    const { el, page } = mountRecovery(env)
    page.recover()
    const screen = el.querySelector<HTMLElement>('[data-dsh-recovery]')!
    await vi.waitFor(() => { expect(screen.textContent).toContain('上次启动时没有失败项。') })
    expect(screen.lang).toBe('zh')
    expect(screen.textContent).toContain('暂无更改。')
    expect(screen.textContent).toContain('安全模式已开启，开始于 2026-11-10T09:00:00.000Z')
    expect(screen.querySelectorAll('button')).toHaveLength(0)
  })

  it('names a state it cannot read', async () => {
    for (const [options, expected] of [
      [{ stateStatus: 500, state: { message: 'record unreadable' } }, '500 record unreadable'],
      [{ stateStatus: 404, state: 'not json at all' }, '404'],
      [{ state: 'not json at all' }, 'Unexpected token'],
    ] as const) {
      const { env } = environment(options)
      const { el, page } = mountRecovery(env)
      page.recover()
      await vi.waitFor(() => { expect(el.textContent).toContain(`Recovery could not read what failed: ${expected}`) })
      page.dispose()
    }
    const failing = environment()
    failing.fetch.mockRejectedValueOnce('offline')
    const { el, page } = mountRecovery(failing.env)
    page.recover()
    await vi.waitFor(() => { expect(el.textContent).toContain('Recovery could not read what failed: offline') })
  })

  it('turns a plugin off after asking, says what happened and reads the state again', async () => {
    const { env, posted, confirm, fetch } = environment({ answers: [{ status: 200, body: { reload: { kind: 'reloaded' } } }, { status: 200, body: { reload: { kind: 'went-back', failure: 'plug-b failed again' } } }, { status: 200, body: { reload: { kind: 'not-running' } } }, { status: 200, body: { reload: { kind: 'went-back' } } }] })
    const { el, page } = mountRecovery(env)
    page.recover()
    await vi.waitFor(() => { expect(el.querySelectorAll('button')).toHaveLength(5) })
    button(el, 'Turn off: plug-b').click()
    await vi.waitFor(() => { expect(el.querySelector('[role="status"]')?.textContent).toBe('Done.') })
    expect(confirm).toHaveBeenCalledWith('Turn off plug-b? It stops running until you turn it on again.')
    expect(posted).toEqual([{ url: '/delo/changes/off', body: { plugin: 'plug-b' } }])
    expect(fetch.mock.calls.filter(([url]) => url === '/delo/changes/state')).toHaveLength(2)
    button(el, 'Undo: Applied').click()
    await vi.waitFor(() => { expect(el.querySelector('[role="status"]')?.textContent).toBe('Delo failed to load it and went back: plug-b failed again') })
    expect(posted[1]).toEqual({ url: '/delo/changes/undo', body: { id: 'c0000000002' } })
    button(el, 'Turn off: plug-a').click()
    await vi.waitFor(() => { expect(el.querySelector('[role="status"]')?.textContent).toBe('Done. Restart Delo to load it: delorun stop, then delorun start.') })
    button(el, 'Turn off: plug-c').click()
    await vi.waitFor(() => { expect(el.querySelector('[role="status"]')?.textContent).toBe('Delo failed to load it and went back: ') })
  })

  it('starts safe mode and names what the next start leaves out', async () => {
    const { env, posted } = environment({ answers: [{ status: 200, body: { lines: ['The next start leaves out plug-b.', 3] } }] })
    const { el, page } = mountRecovery(env)
    page.recover()
    await vi.waitFor(() => { expect(el.querySelectorAll('button')).toHaveLength(5) })
    button(el, 'Start in safe mode').click()
    await vi.waitFor(() => { expect(el.querySelector('[role="status"]')?.textContent).toBe('Done. The next start leaves out plug-b. Restart Delo to load it: delorun stop, then delorun start.') })
    expect(posted).toEqual([{ url: '/delo/changes/safe-mode', body: {} }])
  })

  it('does nothing the person does not confirm, and names a refusal or a failed request', async () => {
    const declined = environment({ confirm: false })
    const first = mountRecovery(declined.env)
    first.page.recover()
    await vi.waitFor(() => { expect(first.el.querySelectorAll('button')).toHaveLength(5) })
    button(first.el, 'Start in safe mode').click()
    expect(declined.posted).toEqual([])
    first.page.dispose()

    const { env } = environment({ answers: [{ status: 409, body: { code: 'NOT_ALLOWED', message: 'plug-z is not turned on.' } }, { status: 500, body: 'not an object' }, new Error('network down'), 'offline'] })
    const { el, page } = mountRecovery(env)
    page.recover()
    await vi.waitFor(() => { expect(el.querySelectorAll('button')).toHaveLength(5) })
    const alert = (): string | null | undefined => el.querySelector('[role="alert"]')?.textContent
    button(el, 'Turn off: plug-a').click()
    await vi.waitFor(() => { expect(alert()).toBe('It did not work: plug-z is not turned on.') })
    button(el, 'Turn off: plug-a').click()
    await vi.waitFor(() => { expect(alert()).toBe('It did not work: 500') })
    button(el, 'Turn off: plug-a').click()
    await vi.waitFor(() => { expect(alert()).toBe('It did not work: network down') })
    button(el, 'Turn off: plug-a').click()
    await vi.waitFor(() => { expect(alert()).toBe('It did not work: offline') })
  })

  it('the recovery screen shows This needs you at your computer for a remote session', async () => {
    // The state says the session is remote, and an action the routes refuse with LOOPBACK_REQUIRED says it again.
    const { env, posted } = environment({ state: { ...STATE, atComputer: false }, answers: [{ status: 403, body: { code: 'LOOPBACK_REQUIRED', message: 'This needs you at your computer.' } }] })
    const { el, page } = mountRecovery(env)
    page.recover()
    const alert = (): string | null | undefined => el.querySelector('[role="alert"]')?.textContent
    await vi.waitFor(() => { expect(alert()).toBe('This needs you at your computer.') })
    button(el, 'Turn off: plug-a').click()
    expect(alert()).toBe('')
    await vi.waitFor(() => { expect(alert()).toBe('This needs you at your computer.') })
    expect(posted).toHaveLength(1)
    expect(el.querySelector('[role="status"]')?.textContent).toBe('')
  })

  it('asks the browser by default', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(STATE)))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('confirm', vi.fn(() => false))
    try {
      const { el, page } = mountRecovery(undefined)
      page.recover()
      await vi.waitFor(() => { expect(el.querySelectorAll('button')).toHaveLength(5) })
      button(el, 'Start in safe mode').click()
      expect(globalThis.confirm).toHaveBeenCalledWith('Start in safe mode next time?')
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
