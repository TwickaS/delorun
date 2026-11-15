// @vitest-environment jsdom
/** The report dialog shows exactly what the link carries, and opening or copying it sends nothing from Delorun. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AboutSection, type AboutSectionProps } from '../src/client/AboutSection.tsx'
import { en } from '../src/client/locales.ts'
import { REPORT_ROUTE, type ReportDetails } from '../src/client/report-api.ts'
import { ReportDialog, ReportFooterButton } from '../src/client/ReportProblem.tsx'
import { REPORT_CHAT_DRAFT, reportChatStarter } from '../src/client/ReportFooterAction.tsx'

const DETAILS: ReportDetails = {
  delorun: '0.1.0-rc.1', dsh: '0.2.2', os: 'Linux 6.6', platform: 'linux x64', excerpt: '2026-11-15T10:00:00.000Z home: failed',
  issueUrl: 'https://github.com/Delo-Run/delorun/issues/new', template: 'bug_report.yml',
}
const t = makeTranslate(en)

/** A fake home that answers the details route, and counts each request. */
function fakeHome(details: ReportDetails = DETAILS) {
  return vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(details), { status: 200, headers: { 'content-type': 'application/json' } })))
}

let browserFetch: ReturnType<typeof vi.fn>
let open: ReturnType<typeof vi.fn>
let beacon: ReturnType<typeof vi.fn>
beforeEach(() => {
  browserFetch = vi.fn(() => Promise.reject(new Error('Delorun must not call the browser fetch here')))
  vi.stubGlobal('fetch', browserFetch)
  open = vi.fn()
  vi.stubGlobal('open', open)
  beacon = vi.fn()
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the report dialog', () => {
  it('reads the details from the home, shows the text that will be sent, and offers the three actions', async () => {
    const home = fakeHome()
    render(<ReportDialog open onClose={() => {}} t={t} surface="computer" fetchImpl={home} />)
    const dialog = await screen.findByRole('dialog', { name: en['report.title'] })
    await within(dialog).findByLabelText(en['report.details'])
    expect(within(dialog).getByLabelText(en['report.details']).textContent).toContain('Delorun 0.1.0-rc.1; DeepSeek Harness 0.2.2; Linux 6.6 (linux x64); studio on computer')
    expect(within(dialog).getByLabelText(en['report.details']).textContent).toContain(DETAILS.excerpt)
    for (const name of [en['report.open'], en['report.copy'], en['report.cancel']]) expect(within(dialog).getByRole('button', { name })).toBeTruthy()
    expect(home).toHaveBeenCalledTimes(1)
    expect(home.mock.calls[0]![0]).toBe(REPORT_ROUTE)
  })

  it('opens the issue form in a new tab without opener access, and makes no request of its own', async () => {
    const home = fakeHome()
    render(<ReportDialog open onClose={() => {}} t={t} surface="computer" fetchImpl={home} />)
    const button = await screen.findByRole('button', { name: en['report.open'] })
    await waitFor(() => { expect((button as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(button)
    expect(open).toHaveBeenCalledTimes(1)
    const [url, target, features] = open.mock.calls[0] as [string, string, string]
    expect(new URL(url).origin + new URL(url).pathname).toBe('https://github.com/Delo-Run/delorun/issues/new')
    expect(new URL(url).searchParams.get('version')).toContain('studio on computer')
    expect([target, features]).toEqual(['_blank', 'noopener,noreferrer'])
    // The one request was the read of the home's own route, made before the click.
    expect(home).toHaveBeenCalledTimes(1)
    expect(browserFetch).not.toHaveBeenCalled()
    expect(beacon).not.toHaveBeenCalled()
  })

  it('copies the full text and says so', async () => {
    render(<ReportDialog open onClose={() => {}} t={t} surface="computer" fetchImpl={fakeHome()} />)
    const copy = await screen.findByRole('button', { name: en['report.copy'] })
    await waitFor(() => { expect((copy as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(copy)
    await screen.findByText(en['report.copied'])
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).toContain(DETAILS.excerpt)
  })

  it('says when the details cannot be read and offers nothing to send', async () => {
    render(<ReportDialog open onClose={() => {}} t={t} surface="computer" fetchImpl={() => Promise.reject(new Error('down'))} />)
    await screen.findByText(en['report.failed'])
    expect((screen.getByRole('button', { name: en['report.open'] }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: en['report.copy'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('closes on Cancel', async () => {
    const onClose = vi.fn()
    render(<ReportDialog open onClose={onClose} t={t} surface="computer" fetchImpl={fakeHome()} />)
    fireEvent.click(await screen.findByRole('button', { name: en['report.cancel'] }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('what the link carries', () => {
  it('says plainly that Open sends the text to github.com, and a checkbox keeps the recent errors out of the link', async () => {
    render(<ReportDialog open onClose={() => {}} t={t} surface="computer" fetchImpl={fakeHome()} />)
    await screen.findByText(en['report.description'])
    expect(en['report.description']).toContain('sends the text below to github.com')
    const box = await screen.findByRole('checkbox', { name: en['report.includeErrors'] }) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(screen.getByLabelText(en['report.details']).textContent).not.toContain(DETAILS.excerpt)
    fireEvent.click(screen.getByRole('button', { name: en['report.open'] }))
    expect(new URL(open.mock.calls[0]![0] as string).searchParams.has('logs')).toBe(false)
  })

  it('reports an approved device\'s versions without asking the home, and says errors come from the computer', async () => {
    const home = fakeHome()
    render(<ReportDialog open onClose={() => {}} t={t} surface="approved device" fetchImpl={home} />)
    await screen.findByText(en['report.deviceNote'])
    expect(home).not.toHaveBeenCalled()
    expect(browserFetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByLabelText(en['report.details']).textContent).toContain('studio on approved device')
  })
})

describe('Help me report this', () => {
  it('starts a chat and closes the dialog, on a phone too, and sends nothing', async () => {
    const startChat = vi.fn()
    const onClose = vi.fn()
    render(<ReportDialog open onClose={onClose} t={t} surface="approved device" fetchImpl={fakeHome()} startChat={startChat} />)
    fireEvent.click(await screen.findByRole('button', { name: en['report.help'] }))
    expect(startChat).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
    expect(browserFetch).not.toHaveBeenCalled()
    expect(beacon).not.toHaveBeenCalled()
  })

  it('has no button where no chat can start', async () => {
    render(<ReportDialog open onClose={() => {}} t={t} surface="computer" fetchImpl={fakeHome()} />)
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: en['report.help'] })).toBeNull()
  })

  it('pre-fills the skill command once, keeps an existing draft, and asks for no send', () => {
    const startSession = vi.fn()
    const ctx = { get: (name: string) => name === 'uiWorkspace' ? { startSession } : undefined }
    reportChatStarter(ctx as never)()
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(startSession).toHaveBeenCalledWith(undefined, { prompt: '/delorun-report-problem ', whenDraftExists: 'keep' })
    expect(REPORT_CHAT_DRAFT).toBe('/delorun-report-problem ')
    expect(Object.keys(startSession.mock.calls[0]![1] as object).sort()).toEqual(['prompt', 'whenDraftExists'])
  })

  it('does nothing while the workspace service is absent', () => {
    expect(() => { reportChatStarter({ get: () => undefined } as never)() }).not.toThrow()
  })
})

describe('the entries', () => {
  it('the footer icon button has an accessible name and opens the dialog', async () => {
    render(<ReportFooterButton t={t} wide surface="computer" fetchImpl={fakeHome()} />)
    fireEvent.click(screen.getByRole('button', { name: en['report.action'] }))
    expect(await screen.findByRole('dialog', { name: en['report.title'] })).toBeTruthy()
  })

  it('the About section offers the same action in its own group', async () => {
    const props = { t, close: () => {}, fetchImpl: fakeHome() } as AboutSectionProps
    render(<AboutSection {...props} />)
    const group = screen.getByRole('region', { name: en['about.report.heading'] })
    fireEvent.click(within(group).getByRole('button', { name: en['about.report.button'] }))
    expect(await screen.findByRole('dialog', { name: en['report.title'] })).toBeTruthy()
  })
})
