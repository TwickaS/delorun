// @vitest-environment jsdom
/** The Branding section's icon picker: it opens from the brand package alone, with no sidebar service on the context. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as pickerEn } from '@delorun/brand/icon-picker-locales'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { en } from '../src/client/branding-locales.ts'
import { BrandingSection, type BrandingSectionProps } from '../src/client/BrandingSection.tsx'
import { themeForm } from './theme-form.client.ts'

afterEach(cleanup)

describe('the Branding section without the sidebar', () => {
  it('opens the icon picker and stores the icon it saves as the picked icon', async () => {
    const form = themeForm(DEFAULT_SETTINGS)
    // The slot's runtime share is the renderer's; the section reads none of it.
    const props = { t: makeTranslate(en), settings: form.scope, pickerT: makeTranslate(pickerEn) } as BrandingSectionProps
    render(<BrandingSection {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['icon.pick'] })) })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(en['picker.title'])).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: pickerEn['icon.save'] })) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(form.scope.getSnapshot().value?.branding.icon).toBe('picked')
  })

  it('opens the file chooser from the Choose an image button, which is a secondary button like Pick an icon', () => {
    const form = themeForm(DEFAULT_SETTINGS)
    const props = { t: makeTranslate(en), settings: form.scope, pickerT: makeTranslate(pickerEn) } as BrandingSectionProps
    const { container } = render(<BrandingSection {...props} />)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const open = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: en['icon.choose'] }))
    expect(open).toHaveBeenCalledOnce()
    expect(input.hidden).toBe(true)
  })
})
