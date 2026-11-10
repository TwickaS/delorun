// @vitest-environment jsdom
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ICON_EMOJIS, IconPicker, type IconPickerTarget } from '../src/client/IconPicker.tsx'
import { en } from '../src/client/locales.ts'
import { GLYPHS, WorkspaceBadge, WorkspaceIconsContext } from '../src/client/WorkspaceBadge.tsx'
import { DEFAULT_WORKSPACE_ICON, ICON_GLYPHS, MAX_ICON_SEED, patternCells, type WorkspaceIcon } from '../src/workspace-icon.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = makeTranslate(en)
const icon = (fields: Partial<WorkspaceIcon>): WorkspaceIcon => ({ ...DEFAULT_WORKSPACE_ICON, ...fields })

/** The badge element a render produced. */
function badgeOf(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement
}

describe('a workspace badge', () => {
  it('draws a glyph for every glyph name the picker offers', () => {
    expect(Object.keys(GLYPHS).sort()).toEqual([...ICON_GLYPHS].sort())
    for (const glyph of ICON_GLYPHS) {
      const { container } = render(<WorkspaceBadge title="x" color="blue" icon={icon({ kind: 'glyph', glyph })} size={30} />)
      const drawing = container.querySelector('svg[data-icon]')
      expect(drawing?.getAttribute('height')).toBe('20')
      cleanup()
    }
  })

  it('shows the initials of the title in the place colour while no icon is chosen', () => {
    const { container } = render(<WorkspaceBadge title="delo run" color="green" workspaceId="w1" />)
    const badge = badgeOf(container)
    expect([badge.textContent, badge.dataset.color, badge.dataset.shape, badge.dataset.style]).toEqual(['DR', 'green', 'rounded', 'soft'])
    expect(badge.getAttribute('aria-hidden')).toBe('true')
    expect(badge.style.getPropertyValue('--badge-size')).toBe('16px')
  })

  it('shows no letters for a title without letters or digits', () => {
    const { container } = render(<WorkspaceBadge title="🙂 --" color="blue" />)
    expect(container.textContent).toBe('')
    expect(container.querySelector('text')).toBeNull()
  })

  it('fits one, two and three letters to the tile and upper-cases them', () => {
    const widths: Array<string | null | undefined> = []
    for (const letters of ['a', 'ab', 'abc', '👩‍💻x']) {
      const { container } = render(<WorkspaceBadge title="x" color="blue" icon={icon({ letters })} />)
      widths.push(container.querySelector('text')?.getAttribute('textLength'))
      cleanup()
    }
    expect(widths).toEqual(['6', '12', '13', '12'])
    const { container } = render(<WorkspaceBadge title="x" color="blue" icon={icon({ letters: 'abc' })} />)
    expect(container.textContent).toBe('ABC')
  })

  it('falls back to the title initials for letters left empty', () => {
    const { container } = render(<WorkspaceBadge title="api server" color="blue" icon={icon({ kind: 'letters', letters: '' })} />)
    expect(container.textContent).toBe('AS')
  })

  it('draws a chosen emoji, glyph or pattern', () => {
    const { container, rerender } = render(<WorkspaceBadge title="x" color="blue" icon={icon({ kind: 'emoji', emoji: '🚀' })} size={40} />)
    expect(container.textContent).toBe('🚀')
    expect(badgeOf(container).style.getPropertyValue('--badge-size')).toBe('40px')
    rerender(<WorkspaceBadge title="x" color="blue" icon={icon({ kind: 'glyph', glyph: 'tree' })} />)
    expect(container.querySelector('svg[data-icon]')).not.toBeNull()
    expect(container.textContent).toBe('')
    rerender(<WorkspaceBadge title="x" color="blue" icon={icon({ kind: 'pattern', seed: 5 })} />)
    expect(container.querySelectorAll('rect')).toHaveLength(patternCells(5).length)
  })

  it('refuses an icon kind it cannot draw', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bogus: WorkspaceIcon = { ...DEFAULT_WORKSPACE_ICON, kind: 'sticker' as never }
    expect(() => render(<WorkspaceBadge title="x" color="blue" icon={bogus} />)).toThrow('Unknown workspace icon kind: sticker')
  })

  it('uses a named colour, the place colour for auto, or a custom hex through a CSS variable', () => {
    const { container, rerender } = render(<WorkspaceBadge title="x" color="green" icon={icon({ color: 'pink' })} />)
    expect(badgeOf(container).dataset.color).toBe('pink')
    expect(badgeOf(container).style.getPropertyValue('--badge-color')).toBe('')
    rerender(<WorkspaceBadge title="x" color="green" icon={icon({ color: 'auto' })} />)
    expect(badgeOf(container).dataset.color).toBe('green')
    rerender(<WorkspaceBadge title="x" color="green" icon={icon({ color: '#12AB34' })} />)
    expect(badgeOf(container).dataset.color).toBeUndefined()
    expect(badgeOf(container).style.getPropertyValue('--badge-color')).toBe('#12AB34')
  })

  it('carries the chosen shape and style as data attributes', () => {
    const { container } = render(<WorkspaceBadge title="x" color="blue" icon={icon({ shape: 'hexagon', style: 'outline' })} />)
    expect([badgeOf(container).dataset.shape, badgeOf(container).dataset.style]).toEqual(['hexagon', 'outline'])
  })

  it('looks the chosen icon up by workspace id, and an icon prop overrides it', () => {
    const chosen = { w1: icon({ letters: 'api', color: 'pink', shape: 'circle', style: 'solid' }) }
    const { container } = render(
      <WorkspaceIconsContext.Provider value={chosen}>
        <WorkspaceBadge title="delo run" color="green" workspaceId="w1" />
        <WorkspaceBadge title="delo run" color="green" workspaceId="other" />
        <WorkspaceBadge title="delo run" color="green" workspaceId="w1" icon={icon({ letters: 'x' })} />
      </WorkspaceIconsContext.Provider>,
    )
    const [looked, unknown, overridden] = Array.from(container.children) as HTMLElement[]
    expect([looked?.textContent, looked?.dataset.color, looked?.dataset.shape, looked?.dataset.style]).toEqual(['API', 'pink', 'circle', 'solid'])
    expect([unknown?.textContent, unknown?.dataset.color]).toEqual(['DR', 'green'])
    expect([overridden?.textContent, overridden?.dataset.color]).toEqual(['X', 'green'])
  })
})

describe('the icon picker', () => {
  const target: IconPickerTarget = { workspaceId: 'w1', title: 'api', color: 'blue', icon: undefined }
  const open = (fields: Partial<IconPickerTarget> = {}) => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(<IconPicker t={t} target={{ ...target, ...fields }} onSave={onSave} onClose={onClose} />)
    return { onSave, onClose }
  }
  const group = (name: string) => within(screen.getByRole('radiogroup', { name }))
  const save = () => { fireEvent.click(screen.getByRole('button', { name: en['icon.save'] })) }

  it('opens on the default icon, showing the initials of a workspace without a choice, and saves it unchanged', () => {
    const { onSave } = open()
    expect(screen.getByRole('tab', { name: en['icon.kind.letters'] }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('dialog', { name: en['icon.title'] }).textContent).toContain('AP')
    save()
    expect(onSave).toHaveBeenCalledWith(DEFAULT_WORKSPACE_ICON)
  })

  it('opens on the stored icon', () => {
    const { onSave } = open({ icon: icon({ kind: 'emoji', emoji: '🌊', color: 'teal', shape: 'square', style: 'outline' }) })
    expect(screen.getByRole('tab', { name: en['icon.kind.emoji'] }).getAttribute('aria-selected')).toBe('true')
    expect(group(en['icon.kind.emoji']).getByRole('radio', { name: '🌊' }).getAttribute('aria-checked')).toBe('true')
    expect(group(en['icon.color']).getByRole('radio', { name: en['icon.color.teal'] }).getAttribute('aria-checked')).toBe('true')
    expect(group(en['icon.shape']).getByRole('radio', { name: en['icon.shape.square'] }).getAttribute('aria-checked')).toBe('true')
    expect(group(en['icon.style']).getByRole('radio', { name: en['icon.style.outline'] }).getAttribute('aria-checked')).toBe('true')
    save()
    expect(onSave).toHaveBeenCalledWith(icon({ kind: 'emoji', emoji: '🌊', color: 'teal', shape: 'square', style: 'outline' }))
  })

  it('switches between the four kinds, each with its own choices', () => {
    open()
    expect(screen.getByPlaceholderText(en['icon.letters.placeholder'])).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: en['icon.kind.glyph'] }))
    expect(screen.queryByPlaceholderText(en['icon.letters.placeholder'])).toBeNull()
    expect(group(en['icon.kind.glyph']).getAllByRole('radio')).toHaveLength(ICON_GLYPHS.length)
    fireEvent.click(screen.getByRole('tab', { name: en['icon.kind.emoji'] }))
    expect(group(en['icon.kind.emoji']).getAllByRole('radio')).toHaveLength(ICON_EMOJIS.length)
    fireEvent.click(screen.getByRole('tab', { name: en['icon.kind.pattern'] }))
    expect(group(en['icon.kind.pattern']).getAllByRole('radio')).toHaveLength(12)
  })

  it('keeps at most three letters', () => {
    const { onSave } = open()
    fireEvent.change(screen.getByPlaceholderText(en['icon.letters.placeholder']), { target: { value: 'abcd' } })
    save()
    expect(onSave).toHaveBeenCalledWith(icon({ letters: 'abc' }))
  })

  it('selects a glyph from the grid by its localised name', () => {
    const { onSave } = open()
    fireEvent.click(screen.getByRole('tab', { name: en['icon.kind.glyph'] }))
    const gear = group(en['icon.kind.glyph']).getByRole('radio', { name: en['icon.glyph.settings'] })
    expect(gear.getAttribute('title')).toBe(en['icon.glyph.settings'])
    fireEvent.click(gear)
    expect(gear.getAttribute('aria-checked')).toBe('true')
    save()
    expect(onSave).toHaveBeenCalledWith(icon({ kind: 'glyph', glyph: 'settings' }))
  })

  it('selects an emoji from the grid, or types one where the last grapheme wins and an empty field is ignored', () => {
    const { onSave } = open()
    fireEvent.click(screen.getByRole('tab', { name: en['icon.kind.emoji'] }))
    fireEvent.click(group(en['icon.kind.emoji']).getByRole('radio', { name: '🌊' }))
    const field = screen.getByLabelText(en['icon.emoji.other'])
    fireEvent.change(field, { target: { value: '🌊🦊👩‍💻' } })
    expect((field as HTMLInputElement).value).toBe('👩‍💻')
    fireEvent.change(field, { target: { value: '' } })
    expect((field as HTMLInputElement).value).toBe('👩‍💻')
    save()
    expect(onSave).toHaveBeenCalledWith(icon({ kind: 'emoji', emoji: '👩‍💻' }))
  })

  it('offers patterns from the stored seed, picks one and shows other patterns on request', () => {
    const { onSave } = open({ icon: icon({ kind: 'pattern', seed: 10 }) })
    const patterns = () => group(en['icon.kind.pattern']).getAllByRole('radio')
    expect(patterns()[0]?.getAttribute('aria-checked')).toBe('true')
    expect(patterns()[1]?.getAttribute('aria-label')).toBe(t('icon.pattern', { n: String(10 + 7_919) }))
    fireEvent.click(patterns()[1] as HTMLElement)
    expect(patterns()[1]?.getAttribute('aria-checked')).toBe('true')
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    fireEvent.click(screen.getByRole('button', { name: en['icon.pattern.more'] }))
    const base = 1 + Math.floor(0.5 * (MAX_ICON_SEED - 1))
    expect(patterns()[0]?.getAttribute('aria-label')).toBe(t('icon.pattern', { n: String(base) }))
    expect(patterns().every(pattern => pattern.getAttribute('aria-checked') === 'false')).toBe(true)
    fireEvent.click(patterns()[2] as HTMLElement)
    save()
    expect(onSave).toHaveBeenCalledWith(icon({ kind: 'pattern', seed: base + 2 * 7_919 }))
  })

  it('never offers the empty seed when a pattern choice wraps around', () => {
    open({ icon: icon({ kind: 'pattern', seed: MAX_ICON_SEED }) })
    expect(group(en['icon.kind.pattern']).getAllByRole('radio')[0]?.getAttribute('aria-label')).toBe(t('icon.pattern', { n: '1' }))
  })

  it('chooses a named colour, the workspace colour or any colour', () => {
    const { onSave } = open({ icon: icon({ color: 'teal' }) })
    const custom = screen.getByLabelText(en['icon.color.custom']) as HTMLInputElement
    expect(custom.value).toBe('#e5734a')
    fireEvent.click(group(en['icon.color']).getByRole('radio', { name: en['icon.color.auto'] }))
    expect(group(en['icon.color']).getByRole('radio', { name: en['icon.color.auto'] }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(group(en['icon.color']).getByRole('radio', { name: en['icon.color.violet'] }))
    save()
    expect(onSave).toHaveBeenLastCalledWith(icon({ color: 'violet' }))
    fireEvent.change(custom, { target: { value: '#aabbcc' } })
    expect(custom.value).toBe('#aabbcc')
    expect(custom.closest('label')?.dataset.checked).toBe('true')
    save()
    expect(onSave).toHaveBeenLastCalledWith(icon({ color: '#AABBCC' }))
  })

  it('chooses a shape and a style', () => {
    const { onSave } = open()
    fireEvent.click(group(en['icon.shape']).getByRole('radio', { name: en['icon.shape.hexagon'] }))
    fireEvent.click(group(en['icon.style']).getByRole('radio', { name: en['icon.style.solid'] }))
    save()
    expect(onSave).toHaveBeenCalledWith(icon({ shape: 'hexagon', style: 'solid' }))
  })

  it('picks a random icon of any kind with Surprise me', () => {
    const { onSave } = open()
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    fireEvent.click(screen.getByRole('button', { name: en['icon.surprise'] }))
    expect(screen.getByRole('tab', { name: en['icon.kind.pattern'] }).getAttribute('aria-selected')).toBe('true')
    save()
    const saved = onSave.mock.calls[0]?.[0] as WorkspaceIcon
    expect(saved.kind).toBe('pattern')
    expect(saved.color).not.toBe('auto')
  })

  it('returns to the initials without asking, and closes from Cancel and the close button', () => {
    const { onSave, onClose } = open({ icon: icon({ kind: 'glyph' }) })
    fireEvent.click(screen.getByRole('button', { name: en['icon.reset'] }))
    expect(onSave).toHaveBeenCalledExactlyOnceWith(null)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['icon.cancel'] }))
    fireEvent.click(screen.getByRole('button', { name: en['icon.close'] }))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
