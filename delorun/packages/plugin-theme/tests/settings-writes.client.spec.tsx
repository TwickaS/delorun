// @vitest-environment jsdom
/** The studio's look controls write what `writesFor` returns, the function the website's setup strip also calls. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSection } from '../src/client/AppearanceSection.tsx'
import { DensityRow, type AppearanceRowProps } from '../src/client/AppearanceRows.tsx'
import { en as brandingEn } from '../src/client/branding-locales.ts'
import { en } from '../src/client/locales.ts'
import { en as pickerEn } from '@delorun/brand/icon-picker-locales'
import * as settings from '../src/settings.ts'
import { STUDIO_ON, themeForm } from './theme-form.client.ts'

vi.mock('../src/settings.ts', async (original) => {
  const actual = await original<typeof settings>()
  return { ...actual, writesFor: vi.fn(actual.writesFor) }
})

afterEach(() => { cleanup(); vi.mocked(settings.writesFor).mockClear() })

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const written = () => vi.mocked(settings.writesFor).mock.results.flatMap(result => result.type === 'return' ? result.value.map(write => [write.path[0], write.value]) : [])

describe('the studio\'s writes', () => {
  it('come from writesFor for a theme tile and for Custom', async () => {
    const form = themeForm({ ...STUDIO_ON, palette: 'ocean' })
    const scheme = { get: () => 'system' as const, subscribe: () => () => undefined, set: () => undefined }
    render(<AppearanceSection t={makeTranslate(en)} settings={form.scope} scheme={scheme} brandingT={makeTranslate(brandingEn)} pickerT={makeTranslate(pickerEn)} />)
    const tiles = within(screen.getByRole('radiogroup', { name: en.palette }))
    await click(tiles.getByRole('radio', { name: en['palette.grove'] }))
    await click(tiles.getByRole('radio', { name: en['palette.custom'] }))
    expect(vi.mocked(settings.writesFor).mock.calls.map(([change]) => change)).toEqual([{ kind: 'palette', palette: 'grove' }, { kind: 'palette', palette: 'custom' }])
    expect(form.writes).toEqual(written())
  })

  it('come from writesFor for a density tile', async () => {
    const form = themeForm(STUDIO_ON)
    // The slot's runtime share is the renderer's; the row reads none of it.
    const props = { t: makeTranslate(en), settings: form.scope, useStockLook: () => Promise.resolve(true) } as AppearanceRowProps
    render(<DensityRow {...props} />)
    await click(within(screen.getByRole('radiogroup', { name: en.density })).getByRole('radio', { name: /Spacious/ }))
    expect(vi.mocked(settings.writesFor).mock.calls.map(([change]) => change)).toEqual([{ kind: 'density', density: 'spacious' }])
    expect(form.writes).toEqual(written())
  })
})
