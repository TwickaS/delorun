// @vitest-environment jsdom
/** The About section names Delorun's licence and links the project's public pages, each in a new tab. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AboutSection, LICENCE_URL, type AboutSectionProps } from '../src/client/AboutSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function renderSection(): void {
  // The renderer's standard props are absent: the section reads none of them.
  const props = { t: makeTranslate(en), close: () => {} } as AboutSectionProps
  render(<AboutSection {...props} />)
}

describe('the About section', () => {
  it('states the licence under its heading and links the licence file', () => {
    renderSection()
    const licences = screen.getByRole('region', { name: en['about.licences.heading'] })
    expect(within(licences).getByText(en['about.licences.body'])).toBeTruthy()
    const link = within(licences).getByRole('link', { name: en['about.licences.link'] })
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual([LICENCE_URL, '_blank', 'noreferrer'])
    expect(LICENCE_URL).toBe('https://github.com/Delo-Run/delo/blob/main/LICENSE')
  })

  it('links the documentation, the source, the issue tracker and support, each in a new tab', () => {
    renderSection()
    const links = within(screen.getByRole('region', { name: en['about.links.heading'] })).getAllByRole('link')
    expect(links.map(link => [link.textContent, link.getAttribute('href')])).toEqual([
      [en['about.links.docs'], 'https://docs.delorun.com'],
      [en['about.links.source'], 'https://github.com/Delo-Run/delo'],
      [en['about.links.issues'], 'https://github.com/Delo-Run/delo/issues'],
      [en['about.links.support'], 'mailto:support@delorun.com'],
    ])
    for (const link of links) expect([link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['_blank', 'noreferrer'])
    expect(screen.getByText('support@delorun.com')).toBeTruthy()
  })

  it('titles itself for a page that does not', () => {
    renderSection()
    expect(screen.getByRole('heading', { level: 2, name: en['about.title'] })).toBeTruthy()
  })
})
