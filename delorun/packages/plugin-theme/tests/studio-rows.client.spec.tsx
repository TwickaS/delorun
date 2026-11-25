// @vitest-environment jsdom
/** The studio plugins' line on the bundle's card: the switch it draws, the write it makes, and where it renders. */
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/plugin-list-locales.ts'
import { StudioRows, type StudioRowsProps } from '../src/client/StudioRows.tsx'
import type { StudioRowsState } from '../src/client/studio-rows-store.ts'
import { STUDIO_BUNDLE } from '../src/client/studio-rows.ts'

afterEach(cleanup)

/** A row of the bundle as the page hands it to the entry. */
function subject(rowId: string, enabled: boolean, pkg = STUDIO_BUNDLE): StudioRowsProps['subject'] {
  return {
    kind: 'row',
    pkg: { name: pkg, installed: true, availability: 'profile', official: true, enabled: true, rows: [] },
    row: { rowId, moduleName: `@delorun/plugin-${rowId}`, enabled },
  }
}

/** The store as the entry reads it, bound as the renderer binds a `hooks` source. */
function source(state: StudioRowsState) {
  return { getSnapshot: () => state, subscribe: () => () => {} }
}

/** Render the entry for one subject, with the store's state and the write it records. */
function open(state: StudioRowsState, row = subject('delorun-cost-meter', false), setEnabled = vi.fn()) {
  const props: StudioRowsProps = {
    subject: row,
    t: makeTranslate(en),
    useRows: bindSnapshotSelector(source(state)),
    setEnabled,
  }
  render(<StudioRows {...props} />)
  return setEnabled
}

/** The state the store holds once the Host has answered. */
const READY: StudioRowsState = {
  rows: [
    { rowId: 'delorun-cost-meter', title: 'Cost meter', entryId: 'entry-cost' as never },
    { rowId: 'delorun-thinking-rsvp', title: 'Thinking tab', entryId: 'entry-thinking' as never },
  ],
}

describe('the studio plugins\' line on the bundle\'s card', () => {
  it('draws the plugin\'s own name and a switch that is off', () => {
    open(READY)
    expect(screen.getByText('Cost meter')).toBeTruthy()
    expect(screen.getByRole('switch', { name: en.studioRowToggle.replace('{name}', 'Cost meter') }).getAttribute('aria-checked')).toBe('false')
  })

  it('shows a row that runs as on', () => {
    open(READY, subject('delorun-cost-meter', true))
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('asks for the row to be turned on, once', () => {
    const setEnabled = open(READY)
    fireEvent.click(screen.getByRole('switch'))
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith('delorun-cost-meter', true)
  })

  it('locks the switch while a write runs, and while the Host refuses the row', () => {
    open({ ...READY, busy: 'delorun-cost-meter' })
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
    cleanup()
    open({ rows: [{ rowId: 'delorun-cost-meter', title: 'Cost meter', readOnlyReason: 'unaddressable' }] })
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  })

  it('says a write was not saved', () => {
    open({ ...READY, failed: 'delorun-cost-meter' })
    expect(screen.getByRole('alert').textContent).toBe(en.studioRowFailed)
  })

  it('renders nothing for a row it does not list, or for another bundle\'s card', () => {
    const unlisted = render(<StudioRows subject={subject('delorun-theme', true)} t={makeTranslate(en)} useRows={bindSnapshotSelector(source(READY))} setEnabled={vi.fn()} />)
    expect(unlisted.container.firstChild).toBeNull()
    cleanup()
    const other = render(<StudioRows subject={subject('delorun-cost-meter', false, '@deepseek-ai/dsh-experimental-voice-input-bundle')} t={makeTranslate(en)} useRows={bindSnapshotSelector(source(READY))} setEnabled={vi.fn()} />)
    expect(other.container.firstChild).toBeNull()
  })

  it('has a Chinese text for every English key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
