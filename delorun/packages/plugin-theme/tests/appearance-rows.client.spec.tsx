// @vitest-environment jsdom
/** The studio half's General rows: Look, Typeface, Density and Reasoning effort labels each write one theme setting. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DensityRow, EffortLabelsRow, StudioLookRow, TypefaceRow, type AppearanceRowProps } from '../src/client/AppearanceRows.tsx'
import { en } from '../src/client/locales.ts'
import { STUDIO_ON, themeForm, type ThemeFormHandle } from './theme-form.client.ts'

afterEach(cleanup)

/**
 * Render one row on a form.
 * @param Row - the row.
 * @param form - the settings form.
 * @param useStockLook - what the Look row's Stock choice calls.
 */
function open(Row: ComponentType<AppearanceRowProps>, form: ThemeFormHandle, useStockLook: () => Promise<boolean> = () => Promise.resolve(true)) {
  // The slot's runtime share is the renderer's; the rows read none of it.
  const props = { t: makeTranslate(en), settings: form.scope, useStockLook } as AppearanceRowProps
  render(<Row {...props} />)
}

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const group = (name: string) => screen.getByRole('radiogroup', { name })

describe('the Look row', () => {
  it('offers Delorun and Stock as a radio group with Delorun chosen, and turns the studio additions off from Stock', async () => {
    const useStockLook = vi.fn(() => Promise.resolve(true))
    open(StudioLookRow, themeForm(STUDIO_ON), useStockLook)
    expect(screen.getAllByText(en.look).length).toBeGreaterThan(0)
    expect(screen.getByText(en['look.lead'])).toBeTruthy()
    const radios = within(group(en.look)).getAllByRole('radio')
    expect(radios.map(radio => [radio.textContent, radio.getAttribute('aria-checked')])).toEqual([['Delorun', 'true'], ['Stock', 'false']])
    await click(screen.getByRole('radio', { name: en['look.stock'] }))
    expect(useStockLook).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a refused way back to the stock look', async () => {
    open(StudioLookRow, themeForm(STUDIO_ON), () => Promise.resolve(false))
    await click(screen.getByRole('radio', { name: en['look.stock'] }))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
  })

  it('says the switch stays on this row in both looks, and names the product Delorun', () => {
    expect(en['look.lead']).toContain('This switch stays here in both looks.')
    expect(en['look.lead']).not.toContain('Delorun ')
  })
})

describe('the Typeface row', () => {
  it('saves the typeface from its tiles, and a typeface already chosen saves nothing', async () => {
    const form = themeForm(STUDIO_ON)
    open(TypefaceRow, form)
    expect(screen.getByText(en['typeface.lead'])).toBeTruthy()
    await click(within(group(en.typeface)).getByRole('radio', { name: /System/ }))
    await click(within(group(en.typeface)).getByRole('radio', { name: /System/ }))
    await click(within(group(en.typeface)).getByRole('radio', { name: /Schibsted/ }))
    expect(form.writes).toEqual([['typeface', 'system'], ['typeface', 'delorun']])
    expect(within(group(en.typeface)).getByRole('radio', { name: /Schibsted/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('points at More font settings in its own card', () => {
    expect(en['typeface.lead']).toContain('More font settings')
  })
})

describe('the Density row', () => {
  it('saves the density from its tiles, and a density already chosen saves nothing', async () => {
    const form = themeForm(STUDIO_ON)
    open(DensityRow, form)
    expect(screen.getByText(en['density.lead'])).toBeTruthy()
    await click(within(group(en.density)).getByRole('radio', { name: /Compact/ }))
    await click(within(group(en.density)).getByRole('radio', { name: /Compact/ }))
    expect(form.writes).toEqual([['density', 'compact']])
  })

  it('reports a write the Host refused or could not carry, and clears the report on the next save', async () => {
    const form = themeForm(STUDIO_ON)
    open(DensityRow, form)
    form.answer = false
    await click(within(group(en.density)).getByRole('radio', { name: /Compact/ }))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
    form.answer = 'throw'
    await click(within(group(en.density)).getByRole('radio', { name: /Spacious/ }))
    expect(screen.getByRole('alert')).toBeTruthy()
    form.answer = true
    await click(within(group(en.density)).getByRole('radio', { name: /Compact/ }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the Reasoning effort labels row', () => {
  it('offers Name and Bars as a radio group and saves the choice', async () => {
    const form = themeForm(STUDIO_ON)
    open(EffortLabelsRow, form)
    expect(screen.getByText('Reasoning effort labels')).toBeTruthy()
    expect(screen.getByText(en['effort.lead'])).toBeTruthy()
    const radios = within(group(en.effort)).getAllByRole('radio')
    expect(radios.map(radio => [radio.textContent, radio.getAttribute('aria-checked')])).toEqual([['Name', 'true'], ['Bars', 'false']])
    await click(screen.getByRole('radio', { name: en['effort.bars'] }))
    expect(form.writes).toEqual([['effort', 'bars']])
  })
})

describe('every row', () => {
  it.each([StudioLookRow, TypefaceRow, DensityRow, EffortLabelsRow])('is locked while the document is not writable', (Row) => {
    const form = themeForm(STUDIO_ON)
    form.publish({ writable: false })
    open(Row, form)
    for (const radio of screen.getAllByRole('radio')) expect(radio.hasAttribute('disabled')).toBe(true)
  })

  it('draws the defaults before the settings arrive', () => {
    open(TypefaceRow, themeForm(undefined))
    expect(within(group(en.typeface)).getByRole('radio', { name: /Schibsted/ }).getAttribute('aria-checked')).toBe('true')
  })
})
