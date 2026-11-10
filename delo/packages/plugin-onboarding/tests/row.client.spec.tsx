// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { ShowAgainRow, type ShowAgainRowProps } from '../src/client/ShowAgainRow.tsx'
import { t } from './fixtures.client.ts'

afterEach(cleanup)

describe('the General row', () => {
  it('names onboarding, says it keeps the settings as they are, and opens it again only when the button is pressed', () => {
    const show = vi.fn()
    render(<ShowAgainRow {...{ t, show } satisfies ShowAgainRowProps} />)
    expect(screen.getByText(en['row.title'])).toBeTruthy()
    expect(screen.getByText(/Your settings stay as they are/)).toBeTruthy()
    expect(show).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en['row.show'] }))
    expect(show).toHaveBeenCalledOnce()
  })
})
