// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPreset, LayoutPicker } from '../../src/layout/index.ts'
import { en } from '../../src/layout/locales.ts'
import { A, B, CHAT, makeStore } from '../entry/fixtures.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

const t = makeTranslate(en)

afterEach(() => { cleanup() })

function setup(settings: Parameters<typeof makeStore>[0] = {}) {
  const made = makeStore(settings)
  made.store.attachHost({ write: async (patch) => { made.change(patch); return true } })
  made.store.pinAll(CHAT, [A, B])
  render(<LayoutPicker chat={CHAT} multiview={made.store} t={t} variant="grid" />)
  return made
}

const radio = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-choice="${id}"]`)!
const checked = () => screen.getAllByRole('radio', { checked: true }).map(radio => radio.getAttribute('data-choice') ?? radio.textContent)

describe('the layout picker', () => {
  it('lists every layout with a picture, Auto checked, one tab stop, and no Yours or Reset before there is one', () => {
    setup()
    const radios = screen.getAllByRole('radio').filter(radio => radio.hasAttribute('data-choice'))
    expect(radios.map(radio => radio.getAttribute('data-choice'))).toEqual(['auto', 'main-stack', 'side-by-side', 'rows', 'grid', 'main-top', 'spiral', 'centred', 'mosaic', 'tabs'])
    expect(radios.every(radio => radio.querySelector('svg') !== null)).toBe(true)
    expect(radios.filter(radio => radio.tabIndex === 0).map(radio => radio.getAttribute('data-choice'))).toEqual(['auto'])
    expect(checked()).toEqual(['auto'])
    expect(screen.queryByRole('button', { name: en['picker.reset'] })).toBeNull()
  })

  it('chooses with a click or the arrow keys, which stay inside it, and makes the choice the default', () => {
    const { store } = setup()
    fireEvent.click(radio('grid'))
    expect(store.arrangementOf(CHAT)).toBe('grid')
    expect(store.settings.getSnapshot().defaultLayout).toBe('grid')
    const outer = { reached: false }
    document.body.addEventListener('keydown', () => { outer.reached = true })
    fireEvent.keyDown(radio('grid'), { key: 'ArrowRight' })
    expect(store.arrangementOf(CHAT)).toBe('main-top')
    expect(document.activeElement?.getAttribute('data-choice')).toBe('main-top')
    expect(outer.reached).toBe(false)
  })

  it('offers the side and the stack for Main and stack, by arrow key too', () => {
    const { store } = setup({ settings: { defaultLayout: 'main-stack' } })
    const side = screen.getByRole('radiogroup', { name: en['picker.side'] })
    const left = side.querySelector<HTMLElement>('[aria-checked="true"]')!
    fireEvent.keyDown(left, { key: 'ArrowRight' })
    expect(store.defaultsOf(CHAT).mainSide).toBe('right')
  })

  it('shows Yours and Reset to Auto once an arrangement is saved, and Reset brings Auto back', () => {
    const { store } = setup()
    act(() => { store.adoptArrangement(CHAT, buildPreset('main-stack', CHAT, [A, B], { mainSide: 'right' }), 'move') })
    expect(checked()).toEqual(['yours'])
    fireEvent.click(screen.getByRole('button', { name: en['picker.reset'] }))
    expect(checked()).toEqual(['auto'])
    expect(document.querySelector('[data-choice="yours"]')).toBeNull()
  })
})
