// @vitest-environment jsdom
/** The parts the website and the docs draw with: tabs, section headings, the code block, the frame and the web switch. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '../src/components/Button.tsx'
import { ButtonLink } from '../src/button-link.web.tsx'
import { CodeBlock, COPY_ANSWER_MS, Frame, SectionHeading, TabList, TabPanel } from '../src/index.ts'
import { Modal, Switch } from '../src/upstream.web.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const CHAPTERS = [{ id: 'ask', label: 'Ask' }, { id: 'review', label: 'Review' }, { id: 'load', label: 'Load' }] as const
type Chapter = typeof CHAPTERS[number]['id']

function Chapters() {
  const [selected, setSelected] = useState<Chapter>('ask')
  return (
    <>
      <TabPanel idBase="replay" selected={selected}>{`Showing ${selected}`}</TabPanel>
      <TabList label="Chapters" idBase="replay" tabs={CHAPTERS} selected={selected} onSelect={setSelected} />
    </>
  )
}

describe('TabList', () => {
  it('is one tab stop whose arrow keys, Home and End select and focus a tab, wrapping at the ends', () => {
    render(<Chapters />)
    const list = screen.getByRole('tablist', { name: 'Chapters' })
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1])
    tabs[0]?.focus()
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tabs[1])
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab').map(tab => tab.tabIndex)).toEqual([-1, 0, -1])
    fireEvent.keyDown(list, { key: 'End' })
    expect(document.activeElement).toBe(tabs[2])
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tabs[0])
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tabs[2])
    fireEvent.keyDown(list, { key: 'Home' })
    expect(document.activeElement).toBe(tabs[0])
  })

  it('names its panel by the selected tab, and a press selects', () => {
    render(<Chapters />)
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    const panel = screen.getByRole('tabpanel', { name: 'Review' })
    expect(panel.textContent).toBe('Showing review')
    expect(screen.getByRole('tab', { name: 'Review' }).getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.tabIndex).toBe(0)
  })

  it('falls back to the first tab when the selection is not in the row, keeping one tab stop', () => {
    const onSelect = vi.fn()
    render(<TabList label="Chapters" idBase="replay" tabs={CHAPTERS} selected={'gone' as Chapter} onSelect={onSelect} />)
    expect(screen.getAllByRole('tab').map(tab => tab.tabIndex)).toEqual([0, -1, -1])
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenCalledWith('review')
  })

  it('leaves the panel out of the tab order when it holds controls', () => {
    render(<TabPanel idBase="replay" selected="ask" focusable={false}><button type="button">Play</button></TabPanel>)
    expect(screen.getByRole('tabpanel').hasAttribute('tabindex')).toBe(false)
  })

  it('leaves other keys to the page', () => {
    render(<Chapters />)
    const list = screen.getByRole('tablist')
    expect(fireEvent.keyDown(list, { key: 'ArrowDown' })).toBe(true)
    expect(fireEvent.keyDown(list, { key: 'ArrowRight' })).toBe(false)
  })
})

describe('SectionHeading', () => {
  it('is a heading of the chosen level with its lead, and no label above it', () => {
    const { rerender } = render(<SectionHeading id="yours" title="Make it yours" lead="Change the page and see the entry." />)
    const heading = screen.getByRole('heading', { level: 2, name: 'Make it yours' })
    expect(heading.id).toBe('yours')
    expect(heading.parentElement?.tagName).toBe('HGROUP')
    expect(heading.parentElement?.firstElementChild).toBe(heading)
    expect(screen.getByText('Change the page and see the entry.').tagName).toBe('P')
    rerender(<SectionHeading level={1} title="Delorun" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Delorun' }).nextElementSibling).toBeNull()
  })
})

describe('CodeBlock', () => {
  const labels = { copyLabel: 'Copy command', copiedLabel: 'Copied', failedLabel: 'Copy failed' }

  it('copies the code exactly, answers in place and announces it, then returns to rest', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<CodeBlock code="npm install -g delorun" {...labels} />)
    const button = screen.getByRole('button', { name: 'Copy command' })
    await act(async () => { fireEvent.click(button) })
    expect(writeText).toHaveBeenCalledWith('npm install -g delorun')
    expect(button.textContent).toBe('Copied')
    expect(button.dataset.answer).toBe('copied')
    expect(screen.getByRole('status').textContent).toBe('Copied')
    act(() => { vi.advanceTimersByTime(COPY_ANSWER_MS) })
    expect(button.dataset.answer).toBe('idle')
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('keeps its lines, takes focus and is named when it scrolls', () => {
    render(<CodeBlock code={'a:\n  b: 1'} scroll codeLabel="Settings entry" {...labels} />)
    const region = screen.getByRole('region', { name: 'Settings entry' })
    expect(region.tabIndex).toBe(0)
    expect(region.hasAttribute('data-scroll')).toBe(true)
  })

  it('does not take focus or a role when it does not scroll', () => {
    render(<CodeBlock code="delorun" {...labels} />)
    expect(screen.queryByRole('region')).toBeNull()
    expect(document.querySelector('pre')?.hasAttribute('tabindex')).toBe(false)
  })

  it('marks the copy button as the main button only when asked', () => {
    const { unmount } = render(<CodeBlock code="delorun" emphasis="primary" {...labels} />)
    expect(screen.getByRole('button', { name: 'Copy command' }).dataset.emphasis).toBe('primary')
    unmount()
    render(<CodeBlock code="delorun" {...labels} />)
    expect(screen.getByRole('button', { name: 'Copy command' }).dataset.emphasis).toBeUndefined()
  })

  it('announces a second copy again with new text in the live region', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
    render(<CodeBlock code="delorun" {...labels} />)
    const button = screen.getByRole('button', { name: 'Copy command' })
    await act(async () => { fireEvent.click(button) })
    const first = screen.getByRole('status').firstElementChild
    await act(async () => { fireEvent.click(button) })
    const second = screen.getByRole('status').firstElementChild
    expect(second?.textContent).toBe('Copied')
    expect(second).not.toBe(first)
  })

  it('says a failed copy in place and selects the code for a copy by hand', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    render(<CodeBlock code="pnpm add -g delorun" caption="pnpm" {...labels} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy command' })) })
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(screen.getByRole('status').textContent).toBe('Copy failed')
    expect(screen.getByText('Copy failed', { selector: 'p' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy command' }).textContent).toBe('')
    // The copy icon stays as a retry; no cross that reads as "clear".
    expect(screen.getByRole('button', { name: 'Copy command' }).querySelector('rect')).not.toBeNull()
    expect(window.getSelection()?.toString()).toBe('pnpm add -g delorun')
    expect(screen.getByRole('figure').querySelector('figcaption')?.textContent).toBe('pnpm')
  })
})

describe('Frame', () => {
  it('holds its size and shows the still until the content is ready', () => {
    const { rerender } = render(<Frame width={1200} height={760} label="The studio" still={<img alt="" src="still.png" />} />)
    const frame = screen.getByRole('figure', { name: 'The studio' })
    expect(frame.style.aspectRatio).toBe('1200 / 760')
    expect(frame.style.getPropertyValue('--frame-width')).toBe('1200px')
    expect(frame.dataset.ready).toBe('false')
    rerender(<Frame width={1200} height={760} label="The studio" still={<img alt="" src="still.png" />} ready={false}><p>live</p></Frame>)
    expect(screen.getByText('live').parentElement?.getAttribute('aria-hidden')).toBe('true')
    rerender(<Frame width={1200} height={760} label="The studio" still={<img alt="" src="still.png" />}><p>live</p></Frame>)
    expect(frame.dataset.ready).toBe('true')
    expect(screen.getByText('live').parentElement?.getAttribute('aria-hidden')).toBe('false')
    expect(frame.querySelector('img')?.parentElement?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('Frame with no content yet', () => {
  it('keeps showing the still when the content is null', () => {
    render(<Frame width={400} height={300} label="The studio" still={<p>still</p>}>{null}</Frame>)
    expect(screen.getByRole('figure').dataset.ready).toBe('false')
    expect(screen.getByText('still').parentElement?.getAttribute('aria-hidden')).toBe('false')
  })
})

describe('the web Switch', () => {
  it('is a named switch that asks for the other state', () => {
    const onChange = vi.fn()
    render(<Switch checked label="Delorun look" onChange={onChange} />)
    const control = screen.getByRole('switch', { name: 'Delorun look' })
    expect(control.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(control)
    expect(onChange).toHaveBeenCalledWith(false)
  })
})

describe('the web Modal', () => {
  // jsdom has no top layer, so the browser's own `showModal` and `close` are stubbed; the sites run where they exist.
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true }
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false }
  })

  it('draws the header, the body and the footer, and puts the caller\'s classes on the card and the content region', () => {
    render(<Modal open onClose={() => {}} title="Rename" closeLabel="Close" description="A new name" className="wide" contentClassName="scrolls" footer={<button type="button">Save</button>}>Body</Modal>)
    const card = screen.getByRole('dialog', { name: 'Rename' })
    expect(card.classList.contains('wide')).toBe(true)
    expect(screen.getByRole('heading', { name: 'Rename' })).toBeTruthy()
    expect(screen.getByText('A new name')).toBeTruthy()
    expect(card.querySelector('.scrolls')?.textContent).toContain('Body')
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('when headless draws the children alone in the card, with no header, close button or footer', () => {
    render(<Modal open headless onClose={() => {}} title="A notice" closeLabel="Close" footer={<button type="button">Save</button>}><h2>Our promise</h2></Modal>)
    const card = screen.getByRole('dialog', { name: 'A notice' })
    expect(screen.getByRole('heading', { name: 'Our promise' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(card.textContent).toBe('Our promise')
  })
})

describe('ButtonLink', () => {
  it('is an anchor with the button\'s classes and the address', () => {
    render(<ButtonLink href="/download" variant="primary">Download</ButtonLink>)
    const link = screen.getByRole('link', { name: 'Download' })
    expect(link.getAttribute('href')).toBe('/download')
    expect(link.dataset.variant).toBe('primary')
    expect(link.getAttribute('aria-disabled')).toBeNull()
  })

  it('stays in the tab order when unavailable, with no address, and does not navigate when pressed', () => {
    render(<><ButtonLink href="/download" unavailable aria-describedby="why">Download</ButtonLink><p id="why">Not yet</p></>)
    const link = screen.getByRole('link', { name: 'Download' })
    expect(link.getAttribute('href')).toBeNull()
    expect(link.getAttribute('aria-disabled')).toBe('true')
    expect(link.tabIndex).toBe(0)
    expect(link.getAttribute('aria-describedby')).toBe('why')
    const pressed = fireEvent.click(link)
    expect(pressed).toBe(false)
  })
})

describe('Button solid', () => {
  it('marks the solid variant, filled with the text colour', () => {
    render(<Button variant="solid">Sign up</Button>)
    expect(screen.getByRole('button', { name: 'Sign up' }).dataset.variant).toBe('solid')
  })
})
