// @vitest-environment jsdom
/** The update notice: the harness's answer read as a notice or as none, its text, dismissal per release and its reads. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ALERT_CLASSES } from '@delorun/brand/alert'
import type { SemanticVersion, Sha256Hex } from '@delorun/contract-release-manifest'
import { UPDATE_COMMAND, UPDATE_NOTICE_PATH, type UpdateNotice } from '@delorun/contract-update-report'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preference } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { DISMISSED_KEY, fetchUpdateNotice, UpdateNoticeStore, type DismissalStorage } from '../src/client/update-notice.ts'
import { UpdateNoticeCard, type UpdateNoticeFace } from '../src/client/UpdateNotice.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const t = makeTranslate(en)
const v = (text: string): SemanticVersion => brandString<SemanticVersion>(text)

/** A notice for Delorun `delorun` on upstream `dsh`, over a running 0.1.2 on 0.2.2. */
function noticeOf(fields: { delorun?: string; dsh?: string; security?: boolean; summary?: string; notes?: boolean; kind?: UpdateNotice['kind']; disables?: number } = {}): UpdateNotice {
  return {
    running: { delorun: v('0.1.2'), dsh: v('0.2.2') },
    release: {
      delorun: v(fields.delorun ?? '0.1.3'), dsh: v(fields.dsh ?? '0.2.2'), channel: 'stable', security: fields.security ?? false,
      ...fields.summary === undefined ? {} : { summary: fields.summary },
      ...fields.notes === true ? { notes: { sha256: brandString<Sha256Hex>('a'.repeat(64)), length: 12 } } : {},
    },
    kind: fields.kind ?? 'patch',
    disables: fields.disables ?? 0,
  }
}

/** Answer every fetch with a body and a status. */
function answer(body: unknown, status = 200) {
  const fetch = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** A storage held in a map. */
function memoryStorage(initial: Record<string, string> = {}): DismissalStorage & { readonly stored: Map<string, string> } {
  const stored = new Map(Object.entries(initial))
  return { stored, read: key => stored.get(key) ?? null, write: (key, value) => { stored.set(key, value) } }
}

/** Render the notice over a fixed notice. */
function show(notice: UpdateNotice | null, dismiss: UpdateNoticeFace['dismiss'] = vi.fn(), notes: UpdateNoticeFace['notes'] = async () => null, remote = false) {
  const face: UpdateNoticeFace = { notice: createSnapshotStore(notice), notes, open: null, canOpen: createSnapshotStore(false), dismiss, remote }
  return render(<UpdateNoticeCard face={face} t={t} />)
}

describe('what\'s new', () => {
  it('offers the button only for a release whose check verified notes', () => {
    show(noticeOf())
    expect(screen.queryByText('What\'s new')).toBeNull()
    cleanup()
    show(noticeOf({ notes: true }))
    expect(screen.getByText('What\'s new')).toBeTruthy()
  })

  it('opens the notes as text in a dialog, never as markup', async () => {
    const markup = '<script>window.hacked = true</script>\n<img src=x onerror=alert(1)>'
    show(noticeOf({ notes: true }), vi.fn(), async () => ({ version: v('0.1.3'), notes: markup }))
    fireEvent.click(screen.getByText('What\'s new'))
    const pre = (await screen.findByText(/window\.hacked/u)).closest('pre')
    expect(pre?.textContent).toBe(markup)
    expect(pre?.querySelector('script, img')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(screen.getByText('What\'s new in 0.1.3')).toBeTruthy()
  })

  it('does not show notes that belong to another release than the card\'s', async () => {
    show(noticeOf({ notes: true }), vi.fn(), async () => ({ version: v('0.1.2'), notes: 'Notes of an older release' }))
    fireEvent.click(screen.getByText('What\'s new'))
    expect(await screen.findByText('The release notes could not be shown.')).toBeTruthy()
    expect(screen.queryByText(/older release/u)).toBeNull()
  })

  it('says the notes could not be shown when the read finds none, and names the dialog in Chinese', async () => {
    show(noticeOf({ notes: true }))
    fireEvent.click(screen.getByText('What\'s new'))
    expect(await screen.findByText('The release notes could not be shown.')).toBeTruthy()
    cleanup()
    const face: UpdateNoticeFace = { notice: createSnapshotStore<UpdateNotice | null>(noticeOf({ notes: true })), notes: async () => ({ version: v('0.1.3'), notes: '- 更新' }), open: null, canOpen: createSnapshotStore(false), dismiss: vi.fn(), remote: false }
    render(<UpdateNoticeCard face={face} t={makeTranslate(zh)} />)
    fireEvent.click(screen.getByText('新功能'))
    expect((await screen.findByText(/更新/u)).closest('pre')?.textContent).toBe('- 更新')
  })
})

describe('reading the notice', () => {
  it('reads the route document-relative and returns the notice it answers, without fields the contract does not name', async () => {
    const notice = noticeOf({ summary: 'Fixes the reach listener' })
    const fetch = answer({ notice: { ...notice, extra: true, release: { ...notice.release, extra: 1 } }, extra: 'x' })
    expect(await fetchUpdateNotice(new AbortController().signal)).toEqual(notice)
    expect(fetch.mock.calls[0]?.[0]).toBe('api/delorunUpdateCheck.notice')
    expect(UPDATE_NOTICE_PATH.slice(1)).toBe('api/delorunUpdateCheck.notice')
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ accept: 'application/json' })
  })

  it('keeps a release without a summary without one', async () => {
    answer({ notice: noticeOf() })
    const read = await fetchUpdateNotice(new AbortController().signal)
    expect(read).toEqual(noticeOf())
    expect(read === null ? true : 'summary' in read.release).toBe(false)
  })

  it('reads no notice when the harness knows of none', async () => {
    answer({ notice: null })
    expect(await fetchUpdateNotice(new AbortController().signal)).toBeNull()
  })

  it('reads no notice when the check is switched off and the route answers 404', async () => {
    answer('Not Found', 404)
    expect(await fetchUpdateNotice(new AbortController().signal)).toBeNull()
  })

  it('reads no notice when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    expect(await fetchUpdateNotice(new AbortController().signal)).toBeNull()
  })

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a body without a notice', {}],
    ['a negative plugin count', { notice: { ...noticeOf(), disables: -1 } }],
    ['a fractional plugin count', { notice: { ...noticeOf(), disables: 1.5 } }],
    ['an unknown kind', { notice: { ...noticeOf(), kind: 'huge' } }],
    ['a version with a leading v', { notice: noticeOf({ delorun: 'v0.1.3' }) }],
    ['a version that is not a string', { notice: { ...noticeOf(), running: { delorun: 1, dsh: '0.2.2' } } }],
    ['a summary with a line break', { notice: noticeOf({ summary: 'One\nTwo' }) }],
    ['a summary with a direction override', { notice: noticeOf({ summary: 'One ‮ two' }) }],
    ['an unknown channel', { notice: { ...noticeOf(), release: { ...noticeOf().release, channel: 'nightly' } } }],
  ])('reads no notice for %s', async (_case, body) => {
    answer(body)
    expect(await fetchUpdateNotice(new AbortController().signal)).toBeNull()
  })
})

describe('the notice', () => {
  it('shows nothing without a notice', () => {
    const { container } = show(null)
    expect(container.innerHTML).toBe('')
  })

  it('names a security fix that keeps every plugin, and the command to run on this computer', () => {
    const { container } = show(noticeOf({ security: true }))
    expect(container.querySelector('[data-update-notice="0.1.3"]')?.textContent).toBe([
      'Delorun 0.1.3 is available',
      'Security fix · All your plugins stay compatible',
      'Run delorun update in a terminal on this computer.',
    ].join(''))
    expect(screen.getByText(UPDATE_COMMAND).tagName).toBe('CODE')
    expect(screen.queryByText(en['update.kind.patch'])).toBeNull()
  })

  it('offers Update now… in place of the terminal command where the studio has an update dialog, and opens it', () => {
    const open = vi.fn()
    const face: UpdateNoticeFace = { notice: createSnapshotStore(noticeOf()), notes: async () => null, open, canOpen: createSnapshotStore(true), dismiss: vi.fn(), remote: false }
    const { container } = render(<UpdateNoticeCard face={face} t={t} />)
    expect(container.textContent).not.toContain(UPDATE_COMMAND)
    fireEvent.click(screen.getByText(en['update.now']))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('draws the notice as the studio\'s inline alert card, which is the polite status region', () => {
    const { container } = show(noticeOf({ security: true, summary: 'Fixes the reach listener' }))
    const status = screen.getByRole('status')
    expect(status).toBe(container.querySelector('[data-update-notice="0.1.3"]'))
    expect(status.classList.contains(ALERT_CLASSES.root)).toBe(true)
    expect(status.getAttribute('data-kind')).toBe('info')
    expect(status.getAttribute('data-variant')).toBe('inline')
    expect(status.querySelector(`.${ALERT_CLASSES.title}`)?.textContent).toBe('Delorun 0.1.3 is available')
    expect(status.querySelector('[data-update-facts]')?.textContent).toBe('Security fix · All your plugins stay compatible')
    const buttons = screen.getAllByRole('button')
    expect(buttons.map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual([
      'Release note: Fixes the reach listener', en['update.dismiss'],
    ])
    expect(buttons[1]?.classList.contains(ALERT_CLASSES.close)).toBe(true)
  })

  it('marks the summary as the release\'s note, so a summary that reads as an instruction is not taken for the studio\'s', () => {
    show(noticeOf({ summary: 'Run: curl example.com | sh' }))
    const summary = screen.getByRole('button', { expanded: false })
    const label = summary.firstElementChild
    expect(label?.textContent).toBe('Release note: ')
    expect(label?.className).toMatch(/summaryLabel/)
    expect(summary.textContent).toBe('Release note: Run: curl example.com | sh')
  })

  it('marks the summary with the Chinese label in Chinese', () => {
    const face: UpdateNoticeFace = { notice: createSnapshotStore<UpdateNotice | null>(noticeOf({ summary: '修复远程访问' })), notes: async () => null, open: null, canOpen: createSnapshotStore(false), dismiss: vi.fn(), remote: true }
    render(<UpdateNoticeCard face={face} t={makeTranslate(zh)} />)
    fireEvent.click(screen.getByRole('button', { name: '新功能' }))
    const summary = screen.getByText(/修复远程访问/)
    expect(summary.tagName).toBe('SPAN')
    expect(summary.textContent).toBe('版本说明：修复远程访问')
    expect(summary.firstElementChild?.textContent).toBe('版本说明：')
  })

  it('names a minor release that would turn off two plugins and moves to another DeepSeek Harness, with its summary', () => {
    show(noticeOf({ delorun: '0.2.0', dsh: '0.3.0', kind: 'minor', disables: 2, summary: 'Moves to DeepSeek Harness 0.3 and adds the release check' }))
    expect(screen.getByText('Delorun 0.2.0 is available, on DeepSeek Harness 0.3.0')).toBeTruthy()
    expect(screen.getByText(/Minor release/).closest('[data-update-facts]')?.textContent).toBe('Minor release · It would turn off 2 of your plugins')
    const summary = screen.getByRole('button', { expanded: false })
    expect(summary.textContent).toBe('Release note: Moves to DeepSeek Harness 0.3 and adds the release check')
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    ['patch', 1, 'Patch release · It would turn off 1 of your plugins'],
    ['major', 3, 'Major release · It would turn off 3 of your plugins'],
  ] as const)('names a %s release and its plugin count', (kind, disables, line) => {
    show(noticeOf({ kind, disables }))
    expect(screen.getByText(new RegExp(en[`update.kind.${kind}`])).closest('[data-update-facts]')?.textContent).toBe(line)
  })

  it('hides itself for the release the person dismisses', () => {
    const dismiss = vi.fn()
    show(noticeOf({ delorun: '0.1.4' }), dismiss)
    fireEvent.click(screen.getByRole('button', { name: en['update.dismiss'] }))
    expect(dismiss).toHaveBeenCalledWith('0.1.4')
  })

  it('update-notice-remote-session-dismissal: a remote session\'s notice has a close button that hides it for the release', () => {
    const dismiss = vi.fn()
    show(noticeOf({ security: true, summary: 'Fixes the reach listener' }), dismiss, undefined, true)
    expect(screen.getAllByRole('button').map(button => button.textContent || button.getAttribute('aria-label'))).toEqual([en['update.whatsNew'], en['update.dismiss']])
    fireEvent.click(screen.getByRole('button', { name: en['update.dismiss'] }))
    expect(dismiss).toHaveBeenCalledWith('0.1.3')
  })

  it('update-notice-remote-compact: a remote page shows one row, and What\'s new opens the kind line, release note and terminal line', () => {
    const { container } = show(noticeOf({ security: true, summary: 'Fixes the reach listener' }), undefined, undefined, true)
    const notice = container.querySelector('[data-update-notice="0.1.3"]')
    expect(notice?.querySelector(`.${ALERT_CLASSES.title}`)?.textContent).toBe('Delorun 0.1.3')
    expect(screen.getByRole('status')).toBe(notice)
    expect(notice?.textContent).toBe(`Delorun 0.1.3${en['update.whatsNew']}`)
    expect(notice?.textContent).not.toContain('Security fix')
    expect(notice?.textContent).not.toContain('Release note')
    expect(notice?.textContent).not.toContain('Run delorun update')
    const toggle = screen.getByRole('button', { name: en['update.whatsNew'] })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(notice?.querySelector('[data-update-details]')?.textContent).toBe('Delorun 0.1.3 is availableSecurity fix · All your plugins stay compatibleRelease note: Fixes the reach listenerRun delorun update on your computer.')
    fireEvent.click(toggle)
    expect(notice?.querySelector('[data-update-details]')).toBeNull()
  })

  it('update-notice-remote-notes: a remote page offers the release notes inside the details', async () => {
    show(noticeOf({ notes: true }), vi.fn(), async () => ({ version: v('0.1.3'), notes: '- Fixed' }), true)
    expect(screen.queryByRole('button', { name: en['update.releaseNotes'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['update.whatsNew'] }))
    fireEvent.click(screen.getByRole('button', { name: en['update.releaseNotes'] }))
    expect((await screen.findByText('- Fixed')).closest('pre')).toBeTruthy()
  })

  it('update-notice-local-layout: the computer\'s page keeps What\'s new in the card\'s text, and the close button after it', () => {
    const { container } = show(noticeOf({ notes: true }))
    const notice = container.querySelector('[data-update-notice]')
    expect([...notice?.querySelectorAll('button') ?? []].map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual([en['update.whatsNew'], en['update.dismiss']])
    expect(notice?.querySelector(`.${ALERT_CLASSES.body} button`)?.textContent).toBe(en['update.whatsNew'])
  })

  it('update-notice-remote-may-true: a remote page the Host lets begin an update shows Update now… under What\'s new, and the close button', () => {
    const open = vi.fn()
    const face: UpdateNoticeFace = { notice: createSnapshotStore<UpdateNotice | null>(noticeOf()), notes: async () => null, open, canOpen: createSnapshotStore(true), dismiss: vi.fn(), remote: true }
    render(<UpdateNoticeCard face={face} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['update.whatsNew'] }))
    fireEvent.click(screen.getByRole('button', { name: en['update.now'] }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: en['update.dismiss'] })).toBeTruthy()
  })

  it('update-notice-remote-may-false: a remote page the Host does not let begin one shows the terminal line and no button', () => {
    const open = vi.fn()
    const canOpen = createSnapshotStore(false)
    const face: UpdateNoticeFace = { notice: createSnapshotStore<UpdateNotice | null>(noticeOf()), notes: async () => null, open, canOpen, dismiss: vi.fn(), remote: true }
    const { container } = render(<UpdateNoticeCard face={face} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['update.whatsNew'] }))
    expect(screen.queryByRole('button', { name: en['update.now'] })).toBeNull()
    expect(container.textContent).toContain('Run delorun update on your computer')
    act(() => { canOpen.set(true) })
    expect(screen.getByRole('button', { name: en['update.now'] })).toBeTruthy()
  })
})

describe('the notice store', () => {
  it('shows the answered notice until its release is dismissed, keeps the dismissal, and shows a newer release again', () => {
    const storage = memoryStorage()
    const store = new UpdateNoticeStore(() => Promise.resolve(null), storage)
    const heard = vi.fn()
    const stop = store.visible.subscribe(heard)
    expect(store.visible.getSnapshot()).toBeNull()
    const first = noticeOf({ delorun: '0.1.3' })
    store.answered.set(first)
    expect(store.visible.getSnapshot()).toBe(first)
    store.dismiss(first.release.delorun)
    expect(store.visible.getSnapshot()).toBeNull()
    expect(storage.stored.get(DISMISSED_KEY)).toBe('0.1.3')
    store.answered.set(noticeOf({ delorun: '0.1.4' }))
    expect(store.visible.getSnapshot()?.release.delorun).toBe('0.1.4')
    expect(heard).toHaveBeenCalledTimes(3)
    stop()
    store.answered.set(null)
    expect(heard).toHaveBeenCalledTimes(3)
  })

  it('starts with the dismissal the browser kept', () => {
    const store = new UpdateNoticeStore(() => Promise.resolve(null), memoryStorage({ [DISMISSED_KEY]: '0.1.3' }))
    store.answered.set(noticeOf({ delorun: '0.1.3' }))
    expect(store.visible.getSnapshot()).toBeNull()
  })

  it('keeps a dismissal for this page when the browser refuses storage', () => {
    window.localStorage.setItem('delorun:sidebar:update.dismissed', '0.1.3')
    expect(new UpdateNoticeStore(() => Promise.resolve(null), preference).dismissed.getSnapshot()).toBe('0.1.3')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const store = new UpdateNoticeStore(() => Promise.resolve(null), preference)
    store.answered.set(noticeOf({ delorun: '0.1.5' }))
    expect(store.visible.getSnapshot()).not.toBeNull()
    store.dismiss(v('0.1.5'))
    expect(store.visible.getSnapshot()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('the notice\'s reads', () => {
  /** A store whose reads the test answers, started over a settable interval and a reset source. */
  function started(minutes = 60) {
    vi.useFakeTimers()
    const pending: Array<(notice: UpdateNotice | null) => void> = []
    const read = vi.fn((_signal: AbortSignal) => new Promise<UpdateNotice | null>((resolve) => { pending.push(resolve) }))
    const store = new UpdateNoticeStore(read, memoryStorage())
    const refresh = createSnapshotStore(minutes)
    const resets = new Set<() => void>()
    const stop = store.start(refresh, (listener) => { resets.add(listener); return () => { resets.delete(listener) } })
    const reset = (): void => { for (const listener of resets) listener() }
    return { store, read, pending, refresh, resets, reset, stop }
  }

  it('reads when it starts, on a new connection, on focus, on becoming visible and at the interval', async () => {
    const s = started()
    expect(s.read).toHaveBeenCalledTimes(1)
    s.reset()
    expect(s.read).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new Event('focus'))
    expect(s.read).toHaveBeenCalledTimes(3)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(s.read).toHaveBeenCalledTimes(3)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(s.read).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(60 * 60_000)
    expect(s.read).toHaveBeenCalledTimes(5)
    s.stop()
  })

  it('re-arms the interval when its setting changes, and only then', () => {
    const s = started(60)
    s.refresh.set(60)
    vi.advanceTimersByTime(30 * 60_000)
    s.refresh.set(5)
    vi.advanceTimersByTime(5 * 60_000)
    expect(s.read).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(25 * 60_000)
    expect(s.read).toHaveBeenCalledTimes(7)
    s.stop()
  })

  it('shows only the latest read\'s answer', async () => {
    const s = started()
    s.reset()
    const [first, second] = s.pending
    second?.(noticeOf({ delorun: '0.1.4' }))
    first?.(noticeOf({ delorun: '0.1.3' }))
    await act(async () => { await Promise.resolve() })
    expect(s.store.answered.getSnapshot()?.release.delorun).toBe('0.1.4')
    s.stop()
  })

  it('stops every read, listener and timer when disposed, and ignores an answer that arrives after', async () => {
    const s = started()
    expect(s.resets.size).toBe(1)
    const signal = s.read.mock.calls[0]?.[0]
    s.stop()
    expect(signal?.aborted).toBe(true)
    expect(s.resets.size).toBe(0)
    s.pending[0]?.(noticeOf())
    await act(async () => { await Promise.resolve() })
    expect(s.store.answered.getSnapshot()).toBeNull()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    s.refresh.set(5)
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(s.read).toHaveBeenCalledTimes(1)
  })
})
