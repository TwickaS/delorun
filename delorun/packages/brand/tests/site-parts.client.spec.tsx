// @vitest-environment jsdom
/** The parts the website and the docs draw with: tabs, section headings, the code block, the frame and the web switch. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeBlock, COPY_ANSWER_MS, Frame, SectionHeading, TabList, TabPanel } from '../src/index.ts'
import { Switch } from '../src/upstream.web.tsx'

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

  it('says a failed copy in place and selects the code for a copy by hand', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    render(<CodeBlock code="pnpm add -g delorun" caption="pnpm" {...labels} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy command' })) })
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(screen.getByRole('status').textContent).toBe('Copy failed')
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
