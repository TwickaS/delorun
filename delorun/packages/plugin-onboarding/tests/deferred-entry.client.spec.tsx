// @vitest-environment jsdom
/**
 * The sidebar's "Finish setup · N left" entry shows at the computer while a phone's deferred step waits, drops a step
 * whose work is done, opens the guide for the deferred steps only, and is absent at zero or away from the computer.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeferredSetupEntry, guideDismissal, readWaiting } from '../src/client/DeferredSetupEntry.tsx'
import { en } from '../src/client/locales.ts'
import type { DeferrableStep, SetupRecord } from '../src/wire.ts'
import type { OnboardingSettings } from '../src/config.ts'
import { liveForm, settings, t } from './fixtures.client.ts'

afterEach(cleanup)

const PIN_OFF = { enabled: false, idleMinutes: 15, lockWhenHidden: false, paused: false }
const PIN_ON = { enabled: true, kind: 'pin', idleMinutes: 15, lockWhenHidden: false, paused: false }

/** The entry over fakes: the record, the reach read, the PIN read and where the page is. */
function services(options: { readonly deferred?: readonly DeferrableStep[]; readonly reach?: 'set-up' | 'off'; readonly pin?: object; readonly computer?: boolean; readonly done?: boolean; readonly dismissed?: readonly string[] } = {}) {
  // The record is read on every mount, so a spec can defer another step and see the entry read it again.
  const record: { deferred: DeferrableStep[] } = { deferred: [...options.deferred ?? []] }
  const cleared: DeferrableStep[] = []
  const defer = vi.fn((id: DeferrableStep, deferred: boolean) => { if (!deferred) cleared.push(id); return Promise.resolve([] as readonly DeferrableStep[]) })
  const reach = vi.fn(() => Promise.resolve(options.reach ?? 'off'))
  const fetch = vi.fn((_input: string) => Promise.resolve(new Response(JSON.stringify(options.pin ?? PIN_OFF))))
  const deferredOnly = createSnapshotStore(false)
  const changed = createSnapshotStore(0)
  const open = vi.fn()
  const progress = liveForm<OnboardingSettings>(settings({ done: options.done ?? true, dismissedSteps: [...options.dismissed ?? []] })).form
  const loadRecord = (): Promise<SetupRecord> => Promise.resolve({ reachSetUp: false, ...record.deferred.length === 0 ? {} : { deferred: [...record.deferred] } })
  return { progress, host: { reach, reachAddress: () => Promise.resolve(undefined), defer }, loadRecord, fetch, atComputer: () => options.computer ?? true, deferredOnly, changed, open, cleared, defer, record }
}

const mount = async (face: ReturnType<typeof services>, wide = true) => {
  const { cleared: _cleared, defer: _defer, record: _record, ...injected } = face
  const view = render(<DeferredSetupEntry wide={wide} t={t} {...injected} />)
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
  return view
}

describe('readWaiting', () => {
  it('counts the deferred steps that have a screen, and drops the ones already done', async () => {
    const face = services({ deferred: ['reach', 'pin', 'approve'], reach: 'set-up', pin: PIN_OFF })
    expect(await readWaiting(face)).toEqual(['pin'])
    expect(face.cleared).toEqual(['reach'])
  })

  it('drops a step whose PIN is set, and keeps it when the PIN cannot be read', async () => {
    const done = services({ deferred: ['pin'], pin: PIN_ON })
    expect(await readWaiting(done)).toEqual([])
    expect(done.cleared).toEqual(['pin'])
    const unreadable = services({ deferred: ['pin'] })
    unreadable.fetch.mockRejectedValue(new Error('down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await readWaiting(unreadable)).toEqual(['pin'])
    expect(unreadable.cleared).toEqual([])
  })

  it('reads nothing more when nothing is deferred', async () => {
    const face = services()
    expect(await readWaiting(face)).toEqual([])
    expect(face.host.reach).not.toHaveBeenCalled()
  })
})

describe('the Finish setup entry', () => {
  it('reads Finish setup while the guide is unfinished and reopens the whole guide, not only the deferred steps', async () => {
    const face = services({ done: false })
    await mount(face)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.finishSetup })) })
    expect(face.deferredOnly.getSnapshot()).toBe(false)
    expect(face.open).toHaveBeenCalledOnce()
  })

  it('counts the deferred steps even while the guide is unfinished, and reopens the guide', async () => {
    const face = services({ done: false, deferred: ['pin'] })
    await mount(face)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['deferred.entry'].replace('{n}', '1') })) })
    expect(face.deferredOnly.getSnapshot()).toBe(false)
  })

  it('names the number of steps left and opens the guide for them only', async () => {
    const face = services({ deferred: ['reach', 'pin'] })
    await mount(face)
    const entry = screen.getByRole('button', { name: en['deferred.entry'].replace('{n}', '2') })
    await act(async () => { fireEvent.click(entry) })
    expect(face.deferredOnly.getSnapshot()).toBe(true)
    expect(face.open).toHaveBeenCalledOnce()
  })

  it('is a labelled line of its own above the foot\'s icon buttons when the sidebar is wide', async () => {
    await mount(services({ done: false }))
    const entry = screen.getByRole('button', { name: en.finishSetup })
    expect(entry.textContent).toBe(en.finishSetup)
    // The line carries the marker, so the foot gives it a row of its own; the entry sits inside it beside the ×.
    expect(entry.closest('[data-sidebar-foot-line]')).not.toBeNull()
  })

  it('is a counted dot in the narrow rail', async () => {
    await mount(services({ deferred: ['pin'] }), false)
    const entry = screen.getByRole('button', { name: en['deferred.entry'].replace('{n}', '1') })
    expect(entry.textContent).toBe('1')
    expect(entry.hasAttribute('data-sidebar-foot-line')).toBe(false)
  })

  it('shows no count in the rail while the guide is unfinished and no step waits', async () => {
    await mount(services({ done: false }), false)
    const entry = screen.getByRole('button', { name: en.finishSetup })
    expect(entry.textContent).toBe('')
    expect(entry.getAttribute('data-delorun-finish-setup-left')).toBe('0')
  })

  it('is absent at zero, once the work is done and away from the computer', async () => {
    await mount(services())
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    await mount(services({ deferred: ['pin'], pin: PIN_ON }))
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    const away = services({ deferred: ['pin'], computer: false })
    await mount(away)
    expect(screen.queryByRole('button')).toBeNull()
    expect(away.fetch).not.toHaveBeenCalled()
  })

  it('dismisses the line, keeping the steps it covered, and stays hidden after a reload', async () => {
    const face = services({ deferred: ['pin'] })
    await mount(face)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['deferred.dismiss'] })) })
    expect(face.progress.getSnapshot().value?.dismissedSteps).toEqual(['pin'])
    expect(screen.queryByRole('button', { name: en['deferred.entry'].replace('{n}', '1') })).toBeNull()
    // A reload reads the same settings, so the line stays hidden.
    cleanup()
    await mount(face)
    expect(screen.queryByRole('button', { name: en['deferred.entry'].replace('{n}', '1') })).toBeNull()
  })

  it('shows the line again when a step the person did not dismiss arrives', async () => {
    const face = services({ deferred: ['pin'], dismissed: ['pin'] })
    await mount(face)
    expect(screen.queryByRole('button', { name: en['deferred.entry'].replace('{n}', '1') })).toBeNull()
    face.record.deferred = ['pin', 'reach']
    await act(async () => { face.changed.set(1); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByRole('button', { name: en['deferred.entry'].replace('{n}', '2') })).toBeTruthy()
  })

  it('keeps the line while the guide is unfinished and nothing was deferred, because a step dismissal does not cover the guide', async () => {
    const face = services({ done: false, dismissed: ['pin'] })
    await mount(face)
    expect(screen.getByRole('button', { name: en.finishSetup })).toBeTruthy()
  })

  it('dismisses "Finish setup" for the guide at its saved step, keeps it hidden after a reload, and shows it once the guide moves on', async () => {
    const face = services({ done: false })
    await face.progress.set('step', 'models')
    await mount(face)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['deferred.dismiss'] })) })
    expect(face.progress.getSnapshot().value?.dismissedSteps).toEqual([guideDismissal('models')])
    expect(screen.queryByRole('button', { name: en.finishSetup })).toBeNull()
    cleanup()
    await mount(face)
    expect(screen.queryByRole('button', { name: en.finishSetup })).toBeNull()
    await act(async () => { await face.progress.set('step', 'look') })
    expect(screen.getByRole('button', { name: en.finishSetup })).toBeTruthy()
  })

  it('shows the line again when a step is deferred after "Finish setup" was dismissed', async () => {
    const face = services({ done: false, dismissed: [guideDismissal('')] })
    await mount(face)
    expect(screen.queryByRole('button', { name: en.finishSetup })).toBeNull()
    face.record.deferred = ['pin']
    await act(async () => { face.changed.set(1); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByRole('button', { name: en['deferred.entry'].replace('{n}', '1') })).toBeTruthy()
  })

  it('reads again when a step changes and when the guide closes', async () => {
    const face = services({ deferred: ['pin'] })
    await mount(face)
    expect(screen.getByRole('button', { name: en['deferred.entry'].replace('{n}', '1') })).toBeTruthy()
    face.fetch.mockResolvedValue(new Response(JSON.stringify(PIN_ON)))
    await act(async () => { face.changed.set(1); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByRole('button')).toBeNull()
  })
})
