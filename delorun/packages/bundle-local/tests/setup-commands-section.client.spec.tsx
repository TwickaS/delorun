// @vitest-environment jsdom
/**
 * The "How Delorun runs" section: each row shows a control and a copy button that copies the terminal command making the
 * same change and names it in its tooltip, the controls send the routes' requests, dangerous mode takes the warning, a
 * No-first question and the typed phrase, a studio away from the computer is offered only what the home answers it, and
 * the warning and the trust statement are the words the command shows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DANGEROUS_PHRASE } from '@delorun/contract-setup-answers'
import { DANGEROUS_WARNING_LINES } from '@delorun/setup-apply/warning'
import { TRUST_STATEMENT } from '@delorun/setup-apply/trust'
import { PROTECTION_PATHS, RESTART_PATHS, STATE_PATH } from '@delorun/plugin-changes/wire'
import { RUN_ROUTES, type RunState } from '../src/client/run-settings-api.ts'
import { TRUST_LINES } from '../src/client/RunReach.tsx'
import { WARNING_LINES } from '../src/client/RunDangerous.tsx'
import { en, zh } from '../src/client/setup-commands-locales.ts'
import { isUsablePort, SETUP_COMMANDS, setupCommand, SetupCommandsSection, type SetupCommandsSectionProps } from '../src/client/SetupCommandsSection.tsx'
import { fakeHost, type Answer, type RouteKey } from './fake-host.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const STATE: RunState = {
  profile: 'default', recorded: true, prompts: 'safer', dangerous: 'off', background: true, port: { chosen: 3080, running: 3080 }, reach: { on: false, address: '' },
}

const ok = (body: unknown): Answer => ({ status: 200, body })
const refused = (status: number, error: string, message: string, fields: object = {}): Answer => ({ status, body: { error, message, ...fields } })

/** The home's answers for the section's reads. */
function reads(state: RunState = STATE): Partial<Record<RouteKey, Answer>> {
  return { [`GET ${RUN_ROUTES.state}`]: ok(state), [`GET ${STATE_PATH}`]: ok({ protection: 'off' }) }
}

/**
 * Render the section over a fake home.
 * @param script - the home's answers by route.
 * @param options - whether the studio is at the computer.
 * @returns the fake home and the PIN opener.
 */
function renderSection(script: Partial<Record<RouteKey, Answer>>, options: { computer?: boolean } = {}) {
  const host = fakeHost(script)
  const openPin = vi.fn()
  const props = { t: makeTranslate(en), close: () => {}, fetch: host.fetch, atComputer: () => options.computer ?? true, openPin } as SetupCommandsSectionProps
  render(<SetupCommandsSection {...props} />)
  return { host, openPin }
}

const row = (name: keyof typeof SETUP_COMMANDS): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-setup-row="${name}"]`)
  if (element === null) throw new Error(`no ${name} row`)
  return element
}

const posts = (host: ReturnType<typeof fakeHost>, path: string) => host.received.filter(request => request.key === `POST ${path}`).map(request => request.body)

describe('the rows', () => {
  it('show each of the four choices with a copy button that names the exact command that makes the same change', async () => {
    renderSection(reads())
    expect(Object.values(SETUP_COMMANDS)).toEqual(['delorun setup prompts', 'delorun setup background', 'delorun setup profile', 'delorun setup reach'])
    expect(screen.getByText(en.intro)).toBeTruthy()
    for (const name of ['prompts', 'background', 'profile', 'reach'] as const) {
      const button = within(row(name)).getByRole('button', { name: en['copy.label'].replace('{command}', SETUP_COMMANDS[name]) })
      expect(button.textContent).toBe(en['copy.action'])
      expect(within(row(name)).getByText(en[`${name}.title`]).textContent).toBe(en[`${name}.title`])
    }
    await screen.findByText(en['port.next'].replace('{port}', '3080'))
  })

  it('shows no bare command line: the command lives in the copy button alone', async () => {
    renderSection(reads())
    await screen.findByText(en['port.next'].replace('{port}', '3080'))
    for (const command of Object.values(SETUP_COMMANDS)) expect(screen.queryByText(command)).toBeNull()
  })

  it('copies the row\'s command and says so, and says when the clipboard refuses', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderSection(reads())
    const button = within(row('background')).getByRole('button', { name: en['copy.label'].replace('{command}', SETUP_COMMANDS.background) })
    fireEvent.click(button)
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(SETUP_COMMANDS.background) })
    // The button's own label carries the answer, and the live region repeats it for a screen reader.
    await waitFor(() => { expect(button.textContent).toBe(en['copy.done']) })
    expect(within(row('background')).getByRole('status').textContent).toBe(en['copy.done'])
    cleanup()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('no')) }, configurable: true })
    renderSection(reads())
    const refused = within(row('prompts')).getByRole('button', { name: en['copy.label'].replace('{command}', SETUP_COMMANDS.prompts) })
    fireEvent.click(refused)
    await waitFor(() => { expect(refused.textContent).toBe(en['copy.failed']) })
  })

  it('leaves the default profile out of the command, as the CLI does', async () => {
    renderSection(reads())
    const button = within(row('prompts')).getByRole('button', { name: en['copy.label'].replace('{command}', SETUP_COMMANDS.prompts) })
    expect(button.getAttribute('aria-label')).not.toContain('--profile')
    expect(setupCommand('prompts', 'default')).toBe('delorun setup prompts')
  })

  it('names a profile other than the default in the command it copies and in its tooltip', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderSection(reads({ ...STATE, profile: 'work' }))
    const command = 'delorun setup prompts --profile work'
    // The command names the profile once the home's state has arrived.
    const button = await within(row('prompts')).findByRole('button', { name: en['copy.label'].replace('{command}', command) })
    fireEvent.click(button)
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(command) })
    fireEvent.focus(button)
    expect((await screen.findByRole('tooltip')).textContent).toBe(en['copy.tooltip'].replace('{command}', command))
    expect(setupCommand('reach', 'work')).toBe('delorun setup reach --profile work')
  })

  it('names the command and what pressing does in the tooltip, which a keyboard reaches', async () => {
    renderSection(reads())
    const button = within(row('profile')).getByRole('button', { name: en['copy.label'].replace('{command}', SETUP_COMMANDS.profile) })
    fireEvent.focus(button)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toBe(en['copy.tooltip'].replace('{command}', SETUP_COMMANDS.profile))
  })

  it('show the answers the home holds: the prompts choice, the background switch, the port and phone access', async () => {
    renderSection(reads({ ...STATE, prompts: 'stock', background: false, port: { chosen: 3090, running: 3080 }, reach: { on: true, address: 'https://home.example.ts.net' } }))
    expect((await within(row('prompts')).findByRole('radio', { name: en['prompts.stock'] })).getAttribute('aria-checked')).toBe('true')
    expect(within(row('prompts')).getByRole('radio', { name: en['prompts.safer'] }).getAttribute('aria-checked')).toBe('false')
    expect(within(row('background')).getByRole('switch', { name: en['background.switch'] }).getAttribute('aria-checked')).toBe('false')
    expect(within(row('profile')).getByText(en['port.now'].replace('{port}', '3080'))).toBeTruthy()
    expect(within(row('profile')).getByText(en['port.next'].replace('{port}', '3090'))).toBeTruthy()
    expect(within(row('reach')).getByText(en['reach.on'])).toBeTruthy()
  })

  it('say when dangerous mode holds, and when it is chosen without its permission file', async () => {
    const on = renderSection(reads({ ...STATE, prompts: 'dangerous', dangerous: 'on' }))
    expect(await screen.findByText(en['dangerous.on'])).toBeTruthy()
    on.host.received.length = 0
    cleanup()
    renderSection(reads({ ...STATE, prompts: 'dangerous', dangerous: 'inactive' }))
    expect(await screen.findByText(en['dangerous.inactive'])).toBeTruthy()
  })

  it('keep the controls off for a profile that setup has not run for, and say why', async () => {
    renderSection(reads({ ...STATE, recorded: false }))
    expect(await screen.findByText(en.notSetUp)).toBeTruthy()
    expect((within(row('background')).getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    expect((within(row('prompts')).getAllByRole('radio') as HTMLButtonElement[]).every(radio => radio.disabled)).toBe(true)
  })

  it('show the home\'s refusal when the state cannot be read', async () => {
    renderSection({ [`GET ${RUN_ROUTES.state}`]: refused(404, 'NO_PROFILE', 'This studio runs without a profile.') })
    expect(await screen.findByText('This studio runs without a profile.')).toBeTruthy()
  })
})

describe('how much Delorun asks', () => {
  it('sends the choice and reads the state again', async () => {
    const { host } = renderSection({ ...reads(), [`POST ${RUN_ROUTES.prompts}`]: ok({ prompts: 'stock', restartNeeded: false }) })
    fireEvent.click(await within(row('prompts')).findByRole('radio', { name: en['prompts.stock'] }))
    await waitFor(() => { expect(posts(host, RUN_ROUTES.prompts)).toEqual([{ answer: 'stock' }]) })
    await waitFor(() => { expect(host.count(`GET ${RUN_ROUTES.state}`)).toBe(2) })
  })

  it('shows the restart note when the home answers that the new prompts apply only after a restart, and not otherwise', async () => {
    const { host } = renderSection({ ...reads(), [`POST ${RUN_ROUTES.prompts}`]: ok({ prompts: 'stock', restartNeeded: true }) })
    fireEvent.click(await within(row('prompts')).findByRole('radio', { name: en['prompts.stock'] }))
    await waitFor(() => { expect(posts(host, RUN_ROUTES.prompts)).toEqual([{ answer: 'stock' }]) })
    expect(await screen.findByText(en['restart.hint'])).toBeTruthy()
  })

  it('does not show the restart note when the prompts apply at once', async () => {
    const { host } = renderSection({ ...reads(), [`POST ${RUN_ROUTES.prompts}`]: ok({ prompts: 'stock', restartNeeded: false }) })
    fireEvent.click(await within(row('prompts')).findByRole('radio', { name: en['prompts.stock'] }))
    await waitFor(() => { expect(host.count(`GET ${RUN_ROUTES.state}`)).toBe(2) })
    expect(screen.queryByText(en['restart.hint'])).toBeNull()
  })

  it('tells a device that needs Face ID or its PIN to confirm and try again', async () => {
    renderSection({ ...reads(), [`POST ${RUN_ROUTES.prompts}`]: refused(403, 'ELEVATION_REQUIRED', 'Confirm with your PIN first', { action: 'bundle-local/run-prompts' }) })
    fireEvent.click(await within(row('prompts')).findByRole('radio', { name: en['prompts.stock'] }))
    expect(await screen.findByText(en['gate.face'])).toBeTruthy()
  })

  it('asks for the warning only when dangerous mode is chosen at the computer, and closing on No changes nothing', async () => {
    const { host } = renderSection({ ...reads(), [`POST ${RUN_ROUTES.dangerousBegin}`]: ok({ warning: [...DANGEROUS_WARNING_LINES], nonce: 'n1', expiresAt: 1, phrase: DANGEROUS_PHRASE }) })
    expect(host.count(`POST ${RUN_ROUTES.dangerousBegin}`)).toBe(0)
    fireEvent.click(await within(row('prompts')).findByRole('radio', { name: en['prompts.dangerous'] }))
    const dialog = await screen.findByRole('dialog', { name: en['dangerous.title'] })
    for (const line of DANGEROUS_WARNING_LINES) expect(within(dialog).getByText(line)).toBeTruthy()
    expect(within(dialog).getByText(en['dangerous.ask'])).toBeTruthy()
    // The first answer is No, which the dialog offers first and closes on.
    const buttons = within(dialog).getAllByRole('button').map(button => button.textContent)
    expect(buttons.indexOf(en['dangerous.no'])).toBeLessThan(buttons.indexOf(en['dangerous.yes']))
    expect(within(dialog).queryByLabelText(en['dangerous.phraseLabel'])).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: en['dangerous.no'] }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(host.count(`POST ${RUN_ROUTES.dangerousConfirm}`)).toBe(0)
    expect(host.count(`POST ${RUN_ROUTES.prompts}`)).toBe(0)
  })

  it('takes the phrase only after Yes, enables the button for the exact phrase alone, and sends the code, the yes and the phrase', async () => {
    const { host } = renderSection({
      ...reads(),
      [`POST ${RUN_ROUTES.dangerousBegin}`]: ok({ warning: [...DANGEROUS_WARNING_LINES], nonce: 'n1', expiresAt: 1, phrase: DANGEROUS_PHRASE }),
      [`POST ${RUN_ROUTES.dangerousConfirm}`]: ok({ dangerous: 'on', restartNeeded: false }),
    })
    fireEvent.click(await within(row('prompts')).findByRole('radio', { name: en['prompts.dangerous'] }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => { expect(host.count(`POST ${RUN_ROUTES.dangerousBegin}`)).toBe(1) })
    fireEvent.click(within(dialog).getByRole('button', { name: en['dangerous.yes'] }))
    const phrase = await within(dialog).findByLabelText(en['dangerous.phraseLabel'])
    expect(within(dialog).getByText(en['dangerous.phrase'].replace('{phrase}', DANGEROUS_PHRASE))).toBeTruthy()
    const confirm = within(dialog).getByRole('button', { name: en['dangerous.confirm'] }) as HTMLButtonElement
    for (const wrong of ['', 'full access', DANGEROUS_PHRASE.toUpperCase(), `${DANGEROUS_PHRASE} `]) {
      fireEvent.change(phrase, { target: { value: wrong } })
      expect(confirm.disabled, wrong).toBe(true)
    }
    fireEvent.change(phrase, { target: { value: DANGEROUS_PHRASE } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => { expect(posts(host, RUN_ROUTES.dangerousConfirm)).toEqual([{ nonce: 'n1', understood: true, phrase: DANGEROUS_PHRASE }]) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(host.count(`POST ${RUN_ROUTES.dangerousBegin}`)).toBe(1)
  })

  it('says the confirmation ran out when the home refuses its code', async () => {
    renderSection({
      ...reads(),
      [`POST ${RUN_ROUTES.dangerousBegin}`]: ok({ warning: [...DANGEROUS_WARNING_LINES], nonce: 'n1', expiresAt: 1, phrase: DANGEROUS_PHRASE }),
      [`POST ${RUN_ROUTES.dangerousConfirm}`]: refused(409, 'CODE_EXPIRED', 'Start again.'),
    })
    fireEvent.click(await within(row('prompts')).findByRole('radio', { name: en['prompts.dangerous'] }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: en['dangerous.yes'] }))
    fireEvent.change(await within(dialog).findByLabelText(en['dangerous.phraseLabel']), { target: { value: DANGEROUS_PHRASE } })
    fireEvent.click(within(dialog).getByRole('button', { name: en['dangerous.confirm'] }))
    expect(await within(dialog).findByText(en['dangerous.expired'])).toBeTruthy()
  })

  it('offers dangerous mode only at the computer: elsewhere it says where, and asks the home for nothing', async () => {
    const { host } = renderSection(reads(), { computer: false })
    expect(await screen.findByText(en.atComputer)).toBeTruthy()
    fireEvent.click(await within(row('prompts')).findByRole('radio', { name: en['prompts.dangerous'] }))
    expect(await screen.findByText(en['prompts.dangerous.away'])).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(host.count(`POST ${RUN_ROUTES.dangerousBegin}`)).toBe(0)
  })
})

describe('running in the background', () => {
  it('sends the switch and says it applies at the next start', async () => {
    const { host } = renderSection({ ...reads(), [`POST ${RUN_ROUTES.background}`]: ok({ background: false, restartNeeded: false }) })
    fireEvent.click(await within(row('background')).findByRole('switch'))
    await waitFor(() => { expect(posts(host, RUN_ROUTES.background)).toEqual([{ on: false }]) })
    expect(await screen.findByText(en['background.next'])).toBeTruthy()
  })

  it('is offered to a device too, and shows the home\'s refusal', async () => {
    renderSection({ ...reads(), [`POST ${RUN_ROUTES.background}`]: refused(409, 'NOT_SET_UP', 'Run delorun setup first.') }, { computer: false })
    fireEvent.click(await within(row('background')).findByRole('switch'))
    expect(await screen.findByText('Run delorun setup first.')).toBeTruthy()
  })
})

describe('the studio port', () => {
  it('accepts a port from 1024 to 65535 and nothing else', () => {
    for (const port of ['1024', '3080', '65535']) expect(isUsablePort(port), port).toBe(true)
    for (const port of ['', '80', '1023', '65536', '70000', '30.5', '-3080', '3080a', ' ']) expect(isUsablePort(port), port).toBe(false)
  })

  it('keeps Change port off for a port the home would refuse, and says why', async () => {
    renderSection(reads())
    const field = await within(row('profile')).findByLabelText(en['port.label'])
    const button = within(row('profile')).getByRole('button', { name: en['port.action'] }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.change(field, { target: { value: '80' } })
    expect(button.disabled).toBe(true)
    expect(within(row('profile')).getByText(en['port.invalid'])).toBeTruthy()
  })

  it('sends the port, says a restart is needed and the address changes, and restarts on request', async () => {
    const { host } = renderSection({
      ...reads(),
      [`POST ${RUN_ROUTES.port}`]: ok({ port: 4100, origin: 'http://127.0.0.1:4100', restartNeeded: true }),
      [`POST ${RESTART_PATHS.restart}`]: ok({ kind: 'restarting', runningChats: 0 }),
    })
    fireEvent.change(await within(row('profile')).findByLabelText(en['port.label']), { target: { value: '4100' } })
    fireEvent.click(within(row('profile')).getByRole('button', { name: en['port.action'] }))
    await waitFor(() => { expect(posts(host, RUN_ROUTES.port)).toEqual([{ port: 4100 }]) })
    expect(await screen.findByText(en['port.saved'].replace('{port}', '4100'))).toBeTruthy()
    expect(screen.getByText(en['restart.hint'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['restart.action'] }))
    await waitFor(() => { expect(posts(host, RESTART_PATHS.restart)).toEqual([{}]) })
    expect(await screen.findByText(en['restart.begun'])).toBeTruthy()
  })

  it('shows the home\'s refusal for a busy port', async () => {
    renderSection({ ...reads(), [`POST ${RUN_ROUTES.port}`]: refused(409, 'PORT_BUSY', 'Port 4100 is in use on this computer. Choose another.') })
    fireEvent.change(await within(row('profile')).findByLabelText(en['port.label']), { target: { value: '4100' } })
    fireEvent.click(within(row('profile')).getByRole('button', { name: en['port.action'] }))
    expect(await screen.findByText('Port 4100 is in use on this computer. Choose another.')).toBeTruthy()
    expect(screen.queryByText(en['restart.hint'])).toBeNull()
  })

  it('is read only away from the computer', async () => {
    renderSection(reads(), { computer: false })
    expect(await within(row('profile')).findByText(en['port.next'].replace('{port}', '3080'))).toBeTruthy()
    expect(within(row('profile')).queryByLabelText(en['port.label'])).toBeNull()
  })
})

describe('phone access', () => {
  const PREVIEW = { address: 'https://home.example.ts.net', trust: [...TRUST_STATEMENT], ticket: 't1', expiresAt: 1 }

  it('shows the address and the trust statement before it changes anything, and sends the ticket once confirmed', async () => {
    const { host } = renderSection({
      ...reads(),
      [`POST ${RUN_ROUTES.reachPreview}`]: ok(PREVIEW),
      [`POST ${RUN_ROUTES.reach}`]: ok({ on: true, address: PREVIEW.address, ready: true, restartNeeded: false }),
      [`POST ${PROTECTION_PATHS.on}`]: ok({ protection: 'on', unreviewedSinceOff: 0 }),
    })
    fireEvent.click(await within(row('reach')).findByRole('switch', { name: en['reach.switch'] }))
    const panel = await waitFor(() => { const found = document.querySelector('[data-reach-preview]'); if (found === null) throw new Error('no preview'); return found as HTMLElement })
    expect(within(panel).getByText(en['reach.preview.address'].replace('{address}', PREVIEW.address))).toBeTruthy()
    for (let index = 1; index <= TRUST_LINES; index += 1) expect(within(panel).getByText(en[`reach.trust.${String(index)}` as 'reach.trust.1'])).toBeTruthy()
    expect(within(panel).getByText(en['reach.preview.tailscale'])).toBeTruthy()
    expect(host.count(`POST ${RUN_ROUTES.reach}`)).toBe(0)
    fireEvent.click(within(panel).getByRole('button', { name: en['reach.confirm'] }))
    await waitFor(() => { expect(posts(host, RUN_ROUTES.reach)).toEqual([{ on: true, ticket: 't1' }]) })
    expect(await screen.findByText(en['reach.ready'].replace('{address}', PREVIEW.address))).toBeTruthy()
  })

  it('changes nothing when the person chooses Not now', async () => {
    const { host } = renderSection({ ...reads(), [`POST ${RUN_ROUTES.reachPreview}`]: ok(PREVIEW) })
    fireEvent.click(await within(row('reach')).findByRole('switch', { name: en['reach.switch'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['reach.cancel'] }))
    await waitFor(() => { expect(document.querySelector('[data-reach-preview]')).toBeNull() })
    expect(host.count(`POST ${RUN_ROUTES.reach}`)).toBe(0)
  })

  it('shows what is wrong with Tailscale and leaves phone access off', async () => {
    renderSection({ ...reads(), [`POST ${RUN_ROUTES.reachPreview}`]: refused(422, 'TAILSCALE_UNAVAILABLE', 'Tailscale is not signed in. Phone access stays off.') })
    fireEvent.click(await within(row('reach')).findByRole('switch', { name: en['reach.switch'] }))
    expect(await screen.findByText('Tailscale is not signed in. Phone access stays off.')).toBeTruthy()
    expect(document.querySelector('[data-reach-preview]')).toBeNull()
  })

  it('once on, offers the PIN link and the switch that holds plugin changes for review, and turns off on request', async () => {
    const { host, openPin } = renderSection({
      ...reads({ ...STATE, reach: { on: true, address: 'https://home.example.ts.net' } }),
      [`POST ${PROTECTION_PATHS.on}`]: ok({ protection: 'on', unreviewedSinceOff: 0 }),
      [`POST ${RUN_ROUTES.reach}`]: ok({ on: false, address: '', ready: false, restartNeeded: false }),
    })
    fireEvent.click(await within(row('reach')).findByRole('button', { name: en['reach.pin'] }))
    expect(openPin).toHaveBeenCalledOnce()
    // Before it is turned off, the row says what turning it off does to the paired devices.
    expect(within(row('reach')).getByText(en['reach.signOut'])).toBeTruthy()
    const protection = await within(row('reach')).findByRole('switch', { name: en['reach.protection'] })
    expect(protection.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(protection)
    await waitFor(() => { expect(posts(host, PROTECTION_PATHS.on)).toEqual([{}]) })
    await waitFor(() => { expect(within(row('reach')).getByRole('switch', { name: en['reach.protection'] }).getAttribute('aria-checked')).toBe('true') })
    fireEvent.click(within(row('reach')).getByRole('switch', { name: en['reach.switch'] }))
    await waitFor(() => { expect(posts(host, RUN_ROUTES.reach)).toEqual([{ on: false }]) })
    expect(await screen.findByText(en['reach.offDone'])).toBeTruthy()
    expect(en['reach.offDone']).toContain('signed out')
  })

  it('says Tailscale may still serve the studio when turning it off could not remove the rule', async () => {
    renderSection({
      ...reads({ ...STATE, reach: { on: true, address: 'https://home.example.ts.net' } }),
      [`POST ${RUN_ROUTES.reach}`]: ok({ on: false, address: '', ready: false, restartNeeded: false, stillServed: 'Run tailscale serve reset.' }),
    })
    fireEvent.click(await within(row('reach')).findByRole('switch', { name: en['reach.switch'] }))
    expect(await screen.findByText(en['reach.stillServed'].replace('{detail}', 'Run tailscale serve reset.'))).toBeTruthy()
  })

  it('is shown, and not changed, away from the computer', async () => {
    renderSection(reads({ ...STATE, reach: { on: true, address: 'https://home.example.ts.net' } }), { computer: false })
    expect(await within(row('reach')).findByText(en['reach.on'])).toBeTruthy()
    expect(within(row('reach')).queryByRole('switch')).toBeNull()
    expect(within(row('reach')).queryByRole('button', { name: en['reach.pin'] })).toBeNull()
  })
})

describe('the copy', () => {
  it('has a Chinese entry for every English one', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
  })

  it('holds the dangerous-mode warning and the trust statement the commands show, word for word', () => {
    // Pins one source of truth: the page's copy cannot drift from the warning a person reads at a terminal.
    expect(Array.from({ length: WARNING_LINES }, (_, index) => en[`dangerous.line.${String(index + 1)}` as 'dangerous.line.1'])).toEqual([...DANGEROUS_WARNING_LINES])
    expect(Array.from({ length: TRUST_LINES }, (_, index) => en[`reach.trust.${String(index + 1)}` as 'reach.trust.1'])).toEqual([...TRUST_STATEMENT])
  })
})
