// @vitest-environment jsdom
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MULTIVIEW_SETTINGS, type MultiviewSettings } from '../../src/config.ts'
import { en } from '../../src/layout/locales.ts'
import type { LayoutShape } from '../../src/layout/model.ts'
import { MultiviewSettingsSection, type MultiviewSettingsSectionProps } from '../../src/panel/settings/Section.tsx'
import { CHAT } from '../entry/fixtures.ts'

afterEach(cleanup)

const t = makeTranslate(en)

const YOURS: LayoutShape = { version: 1, root: { kind: 'leaf', slots: [0], active: 0, size: 100 } }

/** Render the section over a fake settings row and a fake Multiview service. */
function setup(options: { value?: Partial<MultiviewSettings>; writable?: boolean; accepted?: boolean } = {}) {
  const snapshot = {
    status: 'ready' as const,
    value: { ...DEFAULT_MULTIVIEW_SETTINGS, ...options.value },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: options.writable ?? true,
  }
  const set = vi.fn((_field: string, _value: unknown) => Promise.resolve(options.accepted ?? true))
  const form: ConfigForm<Partial<MultiviewSettings>> = {
    getSnapshot: () => snapshot,
    subscribe: vi.fn(() => () => undefined),
    mutate: vi.fn(() => Promise.resolve(true)),
    set,
    unset: vi.fn(() => Promise.resolve(true)),
  }
  const multiview = { resetToAuto: vi.fn() }
  const props = Object.assign({} as MultiviewSettingsSectionProps, { multiview, form, t, mainChat: () => CHAT })
  render(<MultiviewSettingsSection {...props} />)
  return { set, resetToAuto: multiview.resetToAuto }
}

const layoutGroup = () => screen.getByRole('radiogroup', { name: en['section.defaultLayout'] })

describe('the Multiview section of Settings', () => {
  it('shows the four groups', () => {
    setup()
    for (const key of ['section.group.layout', 'section.group.yours', 'section.group.panes', 'section.group.behaviour'] as const) {
      expect(screen.getByRole('heading', { name: en[key] })).toBeTruthy()
    }
    expect(screen.getByRole('spinbutton', { name: en['section.maxPanes'] })).toBeTruthy()
    expect(screen.getByRole('switch', { name: en['section.autoOpen'] })).toBeTruthy()
  })

  it('marks the current layout and writes a chosen one', () => {
    const { set } = setup({ value: { defaultLayout: 'grid' } })
    const radios = within(layoutGroup()).getAllByRole('radio')
    expect(radios.filter(radio => radio.getAttribute('aria-checked') === 'true').map(radio => radio.textContent)).toEqual([en['choice.grid']])
    fireEvent.click(within(layoutGroup()).getByRole('radio', { name: en['choice.rows'] }))
    expect(set).toHaveBeenCalledWith('defaultLayout', 'rows')
  })

  it('offers Yours only when one is saved', () => {
    setup()
    expect(within(layoutGroup()).queryByRole('radio', { name: en['choice.yours'] })).toBeNull()
    cleanup()
    setup({ value: { yours: YOURS, defaultLayout: 'yours' } })
    expect(within(layoutGroup()).getByRole('radio', { name: en['choice.yours'] }).getAttribute('aria-checked')).toBe('true')
  })

  it('reports whether Yours is saved and resets to Auto for the main chat', () => {
    const none = setup()
    expect(screen.getByRole('status').textContent).toBe(en['section.yours.none'])
    fireEvent.click(screen.getByRole('button', { name: en['section.yours.reset'] }))
    expect(none.resetToAuto).toHaveBeenCalledWith(CHAT)
    cleanup()
    setup({ value: { yours: YOURS } })
    expect(screen.getByRole('status').textContent).toBe(en['section.yours.saved'])
  })

  it('writes the other settings', () => {
    const { set } = setup()
    fireEvent.click(screen.getByRole('radio', { name: en['side.right'] }))
    expect(set).toHaveBeenCalledWith('mainSide', 'right')
    fireEvent.click(screen.getByRole('radio', { name: en['section.scope.chat'] }))
    expect(set).toHaveBeenCalledWith('rememberScope', 'chat')
    fireEvent.click(screen.getByRole('switch', { name: en['section.compactComposer'] }))
    expect(set).toHaveBeenCalledWith('compactComposer', false)
    const share = screen.getByRole('spinbutton', { name: en['section.mainShare'] })
    fireEvent.change(share, { target: { value: '90' } })
    fireEvent.blur(share)
    expect(set).toHaveBeenCalledWith('mainShare', 75)
  })

  it('keeps a draft that is not a number from being written', () => {
    const { set } = setup()
    const field = screen.getByRole('spinbutton', { name: en['section.keepChats'] })
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(set).not.toHaveBeenCalled()
    expect((field as HTMLInputElement).value).toBe(String(DEFAULT_MULTIVIEW_SETTINGS.keepChats))
  })

  it('says so when a write is refused', async () => {
    const { set } = setup({ accepted: false })
    fireEvent.click(screen.getByRole('switch', { name: en['section.autoOpen'] }))
    expect(set).toHaveBeenCalledWith('autoOpen', false)
    expect((await screen.findByRole('alert')).textContent).toBe(en['section.failed'])
  })

  it('disables every control when the settings are not writable', () => {
    setup({ writable: false, value: { yours: YOURS } })
    const controls = [...screen.getAllByRole('radio'), ...screen.getAllByRole('switch'), ...screen.getAllByRole('spinbutton'), screen.getByRole('button', { name: en['section.yours.reset'] })]
    expect(controls.length).toBeGreaterThan(20)
    for (const control of controls) expect((control as HTMLButtonElement | HTMLInputElement).disabled).toBe(true)
  })
})
