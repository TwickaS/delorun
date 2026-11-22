// @vitest-environment jsdom
/**
 * The "How Delorun runs" section shows the command for each choice the first-run guide leaves to the terminal, and
 * Phone access also shows whether the home has it on, where the home reports its reach.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DEVICE_ROUTES } from '../src/client/devices-api.ts'
import type { HostFetch } from '../src/client/host-api.ts'
import { en, zh } from '../src/client/setup-commands-locales.ts'
import { SETUP_COMMANDS, SetupCommandsSection, type SetupCommandsSectionProps } from '../src/client/SetupCommandsSection.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * Render the section over a fake home.
 * @param answer - what the reach status route answers: a status and a body, or a failure to connect.
 * @returns the fake request function.
 */
function renderSection(answer: { readonly status: number; readonly body?: unknown } | 'unreachable') {
  const fetch = vi.fn<HostFetch>(async (input) => {
    if (input !== DEVICE_ROUTES.reachStatus || answer === 'unreachable') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  })
  // The renderer's standard props are absent: the section reads none of them.
  const props = { t: makeTranslate(en), close: () => {}, fetch } as SetupCommandsSectionProps
  render(<SetupCommandsSection {...props} />)
  return fetch
}

const row = (name: keyof typeof SETUP_COMMANDS) => {
  const element = document.querySelector<HTMLElement>(`[data-setup-row="${name}"]`)
  if (element === null) throw new Error(`no ${name} row`)
  return element
}

describe('the How Delorun runs section', () => {
  it('shows each of the four choices with the exact command that changes it', () => {
    renderSection({ status: 404, body: { error: 'NOT_FOUND', message: 'No such route' } })
    expect(Object.values(SETUP_COMMANDS)).toEqual(['delorun setup prompts', 'delorun setup background', 'delorun setup profile', 'delorun setup reach'])
    expect(screen.getByText(en.intro)).toBeTruthy()
    expect(['prompts', 'background', 'profile', 'reach'].map(name => within(row(name as keyof typeof SETUP_COMMANDS)).getByLabelText(en.command).textContent)).toEqual(Object.values(SETUP_COMMANDS))
    expect(['prompts', 'background', 'profile', 'reach'].map(name => within(row(name as keyof typeof SETUP_COMMANDS)).getByText(en[`${name as 'prompts'}.title`]).textContent)).toEqual([en['prompts.title'], en['background.title'], en['profile.title'], en['reach.title']])
  })

  it.each([
    ['on', { status: 200, body: { available: true, hasOwner: true, options: [{ option: 'tailscale-private', state: 'ready', address: 'https://home.example.ts.net' }] } }, en['reach.on']],
    ['off', { status: 200, body: { available: true, hasOwner: true, options: [{ option: 'tailscale-private', state: 'off' }] } }, en['reach.off']],
  ] as const)('shows phone access as %s where the home reports its reach', async (_, answer, text) => {
    renderSection(answer)
    expect(await within(row('reach')).findByText(text)).toBeTruthy()
    expect(within(row('prompts')).queryByText(/^Now:/)).toBeNull()
  })

  it('shows the command alone where the home has no reach or its status cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = renderSection('unreachable')
    await waitFor(() => { expect(warn).toHaveBeenCalledWith('delorun settings: the reach status was not read', expect.objectContaining({ path: DEVICE_ROUTES.reachStatus })) })
    expect(fetch).toHaveBeenCalledOnce()
    expect(within(row('reach')).queryByText(/^Now:/)).toBeNull()
    expect(within(row('reach')).getByLabelText(en.command).textContent).toBe(SETUP_COMMANDS.reach)
  })

  it('has a Chinese entry for every English one, with the commands left as they are', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
    expect(Object.values(zh).every(text => !text.includes('delorun setup'))).toBe(true)
  })
})
