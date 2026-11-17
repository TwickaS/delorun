// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StepFooter } from '../src/client/frame/StepFooter.tsx'
import { FooterPortal, StepFrame } from '../src/client/frame/StepFrame.tsx'
import { Card, SUMMARY_LIMIT } from '../src/client/ui/Card.tsx'
import { CommandRow } from '../src/client/ui/CommandRow.tsx'
import { Notice } from '../src/client/ui/Notice.tsx'
import { StateLine } from '../src/client/ui/StateLine.tsx'
import { en } from '../src/client/locales.ts'
import { stepServices } from './fixtures.client.ts'

afterEach(cleanup)

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const LABELS = { more: en.more, less: en.less }

describe('the step frame', () => {
  const frame = (footer?: React.ReactNode, body: React.ReactNode = <p>Body</p>) => render(
    <StepFrame title="Agents" headingRef={null} count="Step 3 of 7" place={3} total={7} steps={['Welcome', 'Models', 'Agents']} stepsLabel="Steps" stepKey="agents" footer={footer}>
      {body}
    </StepFrame>,
  )

  it('pins the step name and "n of 7" with a progress bar above the body, and the footer below it', () => {
    frame(<span>Footer</span>)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Agents')
    const bar = screen.getByRole('progressbar')
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['3', '7'])
    expect(screen.getByText('Step 3 of 7')).toBeTruthy()
    const header = screen.getByRole('banner')
    expect(header.contains(screen.getByRole('heading'))).toBe(true)
    expect(header.contains(screen.getByText('Body'))).toBe(false)
    expect(screen.getByRole('contentinfo').textContent).toBe('Footer')
  })

  it('lists every step for assistive technology and marks the current one', () => {
    frame()
    const items = within(screen.getByRole('navigation', { name: 'Steps' })).getAllByRole('listitem')
    expect(items.map(each => [each.textContent, each.getAttribute('data-state')])).toEqual([['Welcome', 'done'], ['Models', 'done'], ['Agents', 'current']])
  })

  it('shows a step\'s own footer while the step shows, and nothing once it leaves', () => {
    const view = frame(undefined, <FooterPortal><span>Own footer</span></FooterPortal>)
    expect(screen.getByRole('contentinfo').textContent).toBe('Own footer')
    view.rerender(
      <StepFrame title="Agents" headingRef={null} count="Step 3 of 7" place={3} total={7} steps={[]} stepsLabel="Steps" stepKey="other"><p>Other</p></StepFrame>,
    )
    expect(screen.getByRole('contentinfo').textContent).toBe('')
  })
})

describe('the step footer', () => {
  it('has Skip, Back and the primary button, each pressable', async () => {
    const [skip, back, next] = [vi.fn(), vi.fn(), vi.fn()]
    render(<StepFooter skip={{ label: 'Skip', onClick: skip }} back={{ label: 'Back', onClick: back }} next={{ label: 'Continue', onClick: next }} />)
    expect(screen.getAllByRole('button').map(each => each.textContent)).toEqual(['Skip', 'Back', 'Continue'])
    for (const name of ['Skip', 'Back', 'Continue']) await click(screen.getByRole('button', { name }))
    expect([skip, back, next].map(each => each.mock.calls.length)).toEqual([1, 1, 1])
  })

  it('leaves out Skip and Back where the step has none, as on the last step', () => {
    render(<StepFooter next={{ label: 'Start a chat', onClick: () => {} }} />)
    expect(screen.getAllByRole('button').map(each => each.textContent)).toEqual(['Start a chat'])
  })

  it('disables a button that cannot be pressed now', () => {
    render(<StepFooter next={{ label: 'Next', onClick: () => {}, disabled: true }} />)
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('the card', () => {
  const long = 'x'.repeat(SUMMARY_LIMIT + 1)

  it('keeps an icon slot for every card: the plugin\'s image, or a tinted letter', () => {
    render(<><Card title="With" icon="data:image/png;base64,AA==" labels={LABELS} /><Card title="Without" labels={LABELS} /></>)
    const slots = [...document.querySelectorAll('h4')].map(title => title.closest('div')?.parentElement?.firstElementChild as HTMLElement)
    expect(slots[0]?.querySelector('img')).not.toBeNull()
    expect(slots[1]?.textContent).toBe('W')
    expect(slots[1]?.firstElementChild?.getAttribute('data-tint')).not.toBeNull()
  })

  it('shows the full text of a long description only after More, and More says it is expanded', async () => {
    render(<Card title="Long" description={long} labels={LABELS} />)
    const more = screen.getByRole('button', { name: en.more })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-open]')).toBeNull()
    await click(more)
    expect(screen.getByRole('button', { name: en.less }).getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-open]')?.textContent).toBe(long)
  })

  it('puts a leading control, such as a tick, before the icon', () => {
    render(<Card title="T" labels={LABELS} leading={<input type="checkbox" aria-label="Use T" />} />)
    const row = screen.getByRole('checkbox').closest('div') as HTMLElement
    expect(row.firstElementChild?.querySelector('input')).not.toBeNull()
    expect(row.children[1]?.textContent).toBe('T')
  })

  it('offers no More for a description that fits on two lines', () => {
    render(<Card title="Short" description="Short text." labels={LABELS} />)
    expect(screen.queryByRole('button', { name: en.more })).toBeNull()
  })

  it('puts the action beside the title and the state line under the row', () => {
    render(<Card title="T" labels={LABELS} action={<button type="button">Add</button>}><StateLine tone="info">Note</StateLine></Card>)
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Note')
  })
})

describe('the state line', () => {
  it('speaks an error as an alert and every other state politely', () => {
    render(<><StateLine tone="error">Bad</StateLine><StateLine tone="success">Good</StateLine><StateLine tone="warning">Hmm</StateLine></>)
    expect(screen.getByRole('alert').textContent).toContain('Bad')
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })

  it('gives the full message to the reader, however long, with an action in its own control', async () => {
    const retry = vi.fn()
    const message = 'This message is long enough to wrap on a phone and must never be cut off. '.repeat(4).trim()
    render(<StateLine tone="error" action={{ label: 'Try again', onClick: retry }}>{message}</StateLine>)
    expect(screen.getByRole('alert').textContent).toContain(message)
    await click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})

describe('the notice', () => {
  it('shows a short message and keeps the rest behind Read more', () => {
    render(<Notice title="Preview" moreLabel="Read more" more={<p>Details</p>}>Short.</Notice>)
    expect(screen.getByText('Short.')).toBeTruthy()
    expect(screen.getByText('Read more').closest('details')?.hasAttribute('open')).toBe(false)
  })

  it('has no disclosure when there is nothing more, and announces a warning', () => {
    render(<Notice tone="warning">Careful.</Notice>)
    expect(document.querySelector('details')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Careful.')
  })
})

describe('the command row', () => {
  const t = stepServices().t
  it('copies the command and says so, or says the copy failed', async () => {
    const write = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    render(<CommandRow command="delorun devices approve" t={t} />)
    await click(screen.getByRole('button'))
    expect(write).toHaveBeenCalledWith('delorun devices approve')
    expect(screen.getByText(en['copy.done'])).toBeTruthy()
    cleanup()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('no')) }, configurable: true })
    render(<CommandRow command="x" t={t} />)
    await click(screen.getByRole('button'))
    expect(screen.getByText(en['copy.failed'])).toBeTruthy()
  })
})
