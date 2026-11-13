// @vitest-environment jsdom
/** The card, the setting heading, the General row frame and the preview tiles every Delo section shares. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cardCss, SettingHeading, SettingRow, SettingsCard, TileGroup } from '../src/index.ts'

afterEach(cleanup)

describe('the settings card', () => {
  it('is a section named by its heading, with the description above the box and the box holding the settings', () => {
    render(<SettingsCard title="Colours" description="One short sentence." group="colours" className="extra"><p>Mode</p></SettingsCard>)
    const section = screen.getByRole('region', { name: 'Colours' })
    expect(section.dataset.group).toBe('colours')
    expect(screen.getByRole('heading', { level: 3, name: 'Colours' })).toBeTruthy()
    expect(screen.getByText('One short sentence.').tagName).toBe('P')
    const box = screen.getByText('Mode').parentElement as HTMLElement
    expect(box.className.split(' ')).toEqual([cardCss.box, 'extra'])
  })

  it('takes the heading id it is given, and draws no description or extra class without them', () => {
    render(<SettingsCard id="delo-x" title="Folding"><span>Row</span></SettingsCard>)
    expect(screen.getByRole('heading', { name: 'Folding' }).id).toBe('delo-x')
    expect(screen.getByRole('region', { name: 'Folding' }).querySelectorAll('p')).toHaveLength(0)
    expect((screen.getByText('Row').parentElement as HTMLElement).className).toBe(cardCss.box)
  })
})

describe('the setting heading', () => {
  it('draws the title with its id and the help, or the title alone', () => {
    const { rerender } = render(<SettingHeading id="t" title="Thinking" lead="How the reasoning shows." />)
    expect(screen.getByRole('heading', { level: 4, name: 'Thinking' }).id).toBe('t')
    expect(screen.getByText('How the reasoning shows.')).toBeTruthy()
    rerender(<SettingHeading title="Window height" />)
    expect(document.querySelectorAll('p')).toHaveLength(0)
  })
})

describe('the General row frame', () => {
  it('draws the title, the description and the control, and a failure as an alert', () => {
    const { rerender, container } = render(<SettingRow title="Look" titleId="look" description="Delorun or stock." failure="Could not save."><button type="button">Control</button></SettingRow>)
    expect(screen.getByText('Look').id).toBe('look')
    expect(screen.getByRole('alert').textContent).toBe('Could not save.')
    expect((container.firstChild as HTMLElement).className).not.toContain(' ')
    rerender(<SettingRow title="Typeface" description="Fonts." stacked><span>Tiles</span></SettingRow>)
    expect(screen.queryByRole('alert')).toBeNull()
    expect((container.firstChild as HTMLElement).className.split(' ')).toHaveLength(2)
  })
})

describe('the preview tiles', () => {
  const tiles = [{ value: 'a', label: 'Alpha', preview: <i>A</i> }, { value: 'b', label: 'Beta', preview: <i>B</i> }] as const

  it('are a radio group named by its label, the chosen tile checked, and choose only another tile', () => {
    const onChange = vi.fn()
    render(<><span id="name">Letters</span><TileGroup labelledBy="name" className="grid" value="a" tiles={tiles} disabled={false} onChange={onChange} /></>)
    const group = screen.getByRole('radiogroup', { name: 'Letters' })
    expect(group.className.split(' ')).toContain('grid')
    const [alpha, beta] = screen.getAllByRole('radio')
    expect([alpha?.getAttribute('aria-checked'), beta?.getAttribute('aria-checked')]).toEqual(['true', 'false'])
    fireEvent.click(alpha as HTMLElement)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(beta as HTMLElement)
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('refuse every choice while disabled', () => {
    render(<><span id="n">Letters</span><TileGroup labelledBy="n" className={undefined} value="a" tiles={tiles} disabled onChange={vi.fn()} /></>)
    expect(screen.getAllByRole('radio').every(radio => (radio as HTMLButtonElement).disabled)).toBe(true)
  })
})
