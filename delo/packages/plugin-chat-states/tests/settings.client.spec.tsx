// @vitest-environment jsdom
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { SnoozeSettingsSection } from '../src/client/SnoozeSettings.tsx'
import { DEFAULT_CHAT_STATES_SETTINGS, type ChatStatesSettings } from '../src/config.ts'
import { DEFAULT_SNOOZE_PRESETS } from '../src/snooze.ts'

afterEach(cleanup)

/** A form that keeps what is saved, as the settings service does. */
function liveForm(initial: ChatStatesSettings | undefined, options: { writable?: boolean; accept?: boolean; reject?: boolean } = {}) {
  let snapshot: ConfigFormSnapshot<ChatStatesSettings> = {
    status: initial === undefined ? 'unavailable' : 'ready', value: initial, base: undefined, user: undefined, revision: 1, writable: options.writable ?? true,
  }
  const listeners = new Set<() => void>()
  const set = vi.fn((field: string, value: unknown) => {
    if (options.reject === true) return Promise.reject(new Error('transport'))
    if (options.accept === false) return Promise.resolve(false)
    snapshot = { ...snapshot, value: { ...DEFAULT_CHAT_STATES_SETTINGS, ...snapshot.value, [field]: value }, revision: (snapshot.revision ?? 0) + 1 }
    for (const listener of listeners) listener()
    return Promise.resolve(true)
  })
  const form: ConfigForm<ChatStatesSettings> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set, unset: () => Promise.resolve(true), mutate: () => Promise.resolve(true),
  }
  return { form, set, presets: () => snapshot.value?.snoozePresets, days: () => snapshot.value?.autoSettleDays }
}

function mount(form: ConfigForm<ChatStatesSettings>) {
  const reportFailure = vi.fn()
  const view = render(<SnoozeSettingsSection t={makeTranslate(en)} locale={() => 'en'} settings={form} reportFailure={reportFailure} />)
  return { reportFailure, ...view }
}

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const change = async (element: HTMLElement, value: string) => { await act(async () => { fireEvent.change(element, { target: { value } }) }) }
const chip = (name: RegExp) => screen.getByRole('button', { name })
const amount = () => screen.getByRole('spinbutton', { name: en['settings.preset.amount'] })

describe('the section', () => {
  it('heads its two settings with Snooze and idle chats, over one box', () => {
    mount(liveForm(DEFAULT_CHAT_STATES_SETTINGS).form)
    const heading = screen.getByRole('heading', { level: 3 })
    expect(heading.textContent).toBe(en['settings.nav'])
    const region = screen.getByRole('region', { name: en['settings.nav'] })
    expect(within(region).getAllByRole('heading', { level: 4 }).map(title => title.textContent)).toEqual([en['settings.presets'], en['settings.autoSettle']])
  })
})

describe('the snooze presets', () => {
  it('show as chips worded as the snooze menu words them, with their count and no reset while they are the defaults', () => {
    mount(liveForm(DEFAULT_CHAT_STATES_SETTINGS).form)
    expect(screen.getAllByRole('listitem')).toHaveLength(DEFAULT_SNOOZE_PRESETS.length + 1)
    expect(chip(/In 1 hour/)).toBeTruthy()
    expect(chip(/^Today/)).toBeTruthy()
    expect(screen.getByText('5 of 8')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['settings.preset.reset'] })).toBeNull()
  })

  it('open an editor for the picked chip and close it when the chip is picked again', async () => {
    mount(liveForm(DEFAULT_CHAT_STATES_SETTINGS).form)
    await click(chip(/In 1 hour/))
    expect(chip(/In 1 hour/).getAttribute('aria-pressed')).toBe('true')
    expect(amount()).toBeTruthy()
    await click(chip(/In 1 hour/))
    expect(chip(/In 1 hour/).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('spinbutton', { name: en['settings.preset.amount'] })).toBeNull()
  })

  it('edit a length in the unit it was entered in, keep what is typed through an empty or out-of-range field, and clamp a unit change', async () => {
    const { form, presets, set } = liveForm(DEFAULT_CHAT_STATES_SETTINGS)
    mount(form)
    await click(chip(/In 1 hour/))
    expect((amount() as HTMLInputElement).value).toBe('1')
    await change(amount(), '2')
    await click(screen.getByRole('radio', { name: en['custom.unit.days'] }))
    expect(presets()?.[0]).toEqual({ kind: 'after', minutes: 2880 })
    set.mockClear()
    await change(amount(), '')
    await change(amount(), '31')
    await change(amount(), '0')
    expect(set).not.toHaveBeenCalled()
    expect((amount() as HTMLInputElement).value).toBe('0')
    await click(screen.getByRole('radio', { name: en['custom.unit.minutes'] }))
    expect(presets()?.[0]).toEqual({ kind: 'after', minutes: 1 })
    await change(amount(), '')
    await click(screen.getByRole('radio', { name: en['custom.unit.days'] }))
    expect(presets()?.[0]).toEqual({ kind: 'after', minutes: 1440 })
    await change(amount(), '30')
    await click(screen.getByRole('radio', { name: en['custom.unit.hours'] }))
    expect(presets()?.[0]).toEqual({ kind: 'after', minutes: 1800 })
    await click(screen.getByRole('radio', { name: en['custom.unit.days'] }))
    await change(amount(), '30')
    await click(screen.getByRole('radio', { name: en['custom.unit.hours'] }))
    await change(amount(), '720')
    await click(screen.getByRole('radio', { name: en['custom.unit.days'] }))
    expect(presets()?.[0]).toEqual({ kind: 'after', minutes: 43_200 })
  })

  it('edit a day and a time, ignoring a day that is already chosen and a time that is not complete', async () => {
    const { form, presets, set } = liveForm(DEFAULT_CHAT_STATES_SETTINGS)
    mount(form)
    await click(chip(/^Today/))
    const friday = screen.getByRole('button', { name: en['settings.day.friday'] })
    expect(screen.getByRole('button', { name: en['settings.day.today'], pressed: true })).toBeTruthy()
    await click(screen.getByRole('button', { name: en['settings.day.today'], pressed: true }))
    expect(set).not.toHaveBeenCalled()
    await click(friday)
    await change(screen.getByLabelText(en['settings.preset.time']), '19:30')
    await change(screen.getByLabelText(en['settings.preset.time']), '')
    expect(presets()?.[2]).toEqual({ kind: 'at', day: 'friday', time: '19:30' })
    expect(set).toHaveBeenCalledTimes(2)
  })

  it('switch an option between a length and a day, and remove one while more than one remain', async () => {
    const { form, presets } = liveForm(DEFAULT_CHAT_STATES_SETTINGS)
    mount(form)
    await click(chip(/In 1 hour/))
    await click(screen.getByRole('radio', { name: en['settings.preset.at'] }))
    expect(presets()?.[0]).toEqual({ kind: 'at', day: 'tomorrow', time: '09:00' })
    await click(screen.getByRole('radio', { name: en['settings.preset.after'] }))
    expect(presets()?.[0]).toEqual({ kind: 'after', minutes: 120 })
    await click(screen.getByRole('button', { name: en['settings.preset.remove'] }))
    expect(presets()).toHaveLength(4)
    expect(screen.queryByRole('spinbutton', { name: en['settings.preset.amount'] })).toBeNull()
  })

  it('offer an option\'s kind and unit as radio groups whose arrow keys move and save the choice', async () => {
    const { form, presets } = liveForm(DEFAULT_CHAT_STATES_SETTINGS)
    mount(form)
    await click(chip(/In 1 hour/))
    const units = within(screen.getByRole('radiogroup', { name: en['settings.preset.unit'] })).getAllByRole('radio')
    expect(units.map(unit => unit.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    await act(async () => { fireEvent.keyDown(units[1]!, { key: 'ArrowRight' }) })
    expect(presets()?.[0]).toEqual({ kind: 'after', minutes: 1440 })
    const after = screen.getByRole('radio', { name: en['settings.preset.after'] })
    expect(screen.getByRole('radiogroup', { name: en['settings.preset.kind'] }).contains(after)).toBe(true)
    await act(async () => { fireEvent.keyDown(after, { key: 'ArrowRight' }) })
    expect(presets()?.[0]).toEqual({ kind: 'at', day: 'tomorrow', time: '09:00' })
    expect(screen.queryAllByRole('tab')).toEqual([])
  })

  it('add an option up to the limit, open its editor, reset to the defaults, and keep the last option', async () => {
    const { form, presets } = liveForm(DEFAULT_CHAT_STATES_SETTINGS)
    mount(form)
    for (let added = 0; added < 3; added += 1) await click(chip(new RegExp(en['settings.preset.add'])))
    expect(presets()).toHaveLength(8)
    expect((chip(new RegExp(en['settings.preset.add'])) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('8 of 8')).toBeTruthy()
    expect(amount()).toBeTruthy()
    await click(screen.getByRole('button', { name: en['settings.preset.reset'] }))
    expect(presets()).toEqual(DEFAULT_SNOOZE_PRESETS)
    expect(screen.queryByRole('spinbutton', { name: en['settings.preset.amount'] })).toBeNull()
  })

  it('cannot remove the last option', async () => {
    mount(liveForm({ ...DEFAULT_CHAT_STATES_SETTINGS, snoozePresets: [{ kind: 'after', minutes: 30 }] }).form)
    await click(chip(/In 30 minutes/))
    expect((screen.getByRole('button', { name: en['settings.preset.remove'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('word times in the studio\'s language', () => {
    render(<SnoozeSettingsSection t={makeTranslate(en)} locale={() => 'de'} reportFailure={vi.fn()}
      settings={liveForm({ ...DEFAULT_CHAT_STATES_SETTINGS, snoozePresets: [{ kind: 'at', day: 'friday', time: '17:30' }] }).form} />)
    expect(screen.getByText(new Date(2026, 0, 1, 17, 30).toLocaleTimeString('de', { hour: 'numeric', minute: '2-digit' }))).toBeTruthy()
  })
})

describe('auto-settle', () => {
  it('turns on with three days, shows the days, accepts a number from 1 to 90, and turns off', async () => {
    const { form, days, set } = liveForm(DEFAULT_CHAT_STATES_SETTINGS)
    mount(form)
    expect(screen.queryByRole('spinbutton', { name: en['settings.autoSettle.days'] })).toBeNull()
    await click(screen.getByRole('switch', { name: en['settings.autoSettle'] }))
    expect(days()).toBe(3)
    const field = () => screen.getByRole('spinbutton', { name: en['settings.autoSettle.days'] })
    await change(field(), '7')
    expect(days()).toBe(7)
    set.mockClear()
    await change(field(), '0')
    await change(field(), '91')
    await change(field(), '')
    expect(set).not.toHaveBeenCalled()
    await click(screen.getByRole('switch', { name: en['settings.autoSettle'] }))
    expect(days()).toBe(0)
  })
})

describe('a setting that cannot be saved', () => {
  it('reports a refused write, and one that failed in transit, through the notice that outlives the section', async () => {
    const refused = mount(liveForm(DEFAULT_CHAT_STATES_SETTINGS, { accept: false }).form)
    await click(screen.getByRole('switch', { name: en['settings.autoSettle'] }))
    expect(refused.reportFailure).toHaveBeenCalledOnce()
    cleanup()
    const failed = mount(liveForm(DEFAULT_CHAT_STATES_SETTINGS, { reject: true }).form)
    await click(chip(new RegExp(en['settings.preset.add'])))
    expect(failed.reportFailure).toHaveBeenCalledOnce()
  })

  it('does not report a write the settings accepted', async () => {
    const { reportFailure } = mount(liveForm(DEFAULT_CHAT_STATES_SETTINGS).form)
    await click(screen.getByRole('switch', { name: en['settings.autoSettle'] }))
    expect(reportFailure).not.toHaveBeenCalled()
  })

  it('is read-only while the settings document refuses writes', () => {
    mount(liveForm({ ...DEFAULT_CHAT_STATES_SETTINGS, snoozePresets: [{ kind: 'after', minutes: 30 }], autoSettleDays: 3 }, { writable: false }).form)
    for (const control of [chip(/In 30 minutes/), chip(new RegExp(en['settings.preset.add'])), screen.getByRole('switch', { name: en['settings.autoSettle'] }), screen.getByRole('spinbutton', { name: en['settings.autoSettle.days'] })]) {
      expect((control as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('shows the defaults while the settings have not arrived', () => {
    mount(liveForm(undefined).form)
    expect(screen.getAllByRole('listitem')).toHaveLength(DEFAULT_SNOOZE_PRESETS.length + 1)
  })
})

describe('an editor over read-only settings', () => {
  it('disables every control of the editor', async () => {
    const live = liveForm({ ...DEFAULT_CHAT_STATES_SETTINGS, snoozePresets: [{ kind: 'at', day: 'monday', time: '09:00' }, { kind: 'after', minutes: 5 }] })
    const { rerender } = mount(live.form)
    await click(chip(/Monday/))
    rerender(<SnoozeSettingsSection t={makeTranslate(en)} locale={() => 'en'} settings={liveForm(live.form.getSnapshot().value, { writable: false }).form} reportFailure={vi.fn()} />)
    expect((screen.getByLabelText(en['settings.preset.time']) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: en['settings.day.friday'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})
