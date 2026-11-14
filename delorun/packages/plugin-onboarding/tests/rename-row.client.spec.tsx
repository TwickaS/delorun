// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RenameRow, renameModel, type RenameRowProps } from '../src/client/RenameRow.tsx'
import { en, zh } from '../src/client/locales.ts'
import { t } from './fixtures.client.ts'

afterEach(cleanup)

type Block = Extract<RenameRowProps, { phase: 'started' | 'running' | 'settled' }>['block']

const args = JSON.stringify({ workspace: 'Old', name: 'New' })
/** A call that is still running. */
const running = { callId: 'c1', name: 'rename_workspace', argsRaw: args } as Block
/** A settled call with the given result fields. */
const settled = (fields: Record<string, unknown>) => ({
  kind: 'tool-result', callId: 'c1', name: 'rename_workspace', call: { name: 'rename_workspace', argsRaw: args }, content: [], isError: false, ...fields,
}) as Block

/** The row over a block, as a started call. */
const show = (block: Block) => render(<RenameRow {...{ phase: 'result', block, t } as RenameRowProps} />)

describe('the rename_workspace row model', () => {
  it('reads the old and new name from the persisted result', () => {
    expect(renameModel(settled({ meta: { from: 'Old', to: 'New' } }))).toEqual({ state: 'renamed', from: 'Old', to: 'New' })
  })
  it('says so when the name did not change', () => {
    expect(renameModel(settled({ meta: { from: 'Same', to: 'Same' } }))).toEqual({ state: 'same', to: 'Same' })
  })
  it('shows the call while it runs, and for a result with no metadata', () => {
    expect(renameModel(running)).toEqual({ state: 'running', target: 'Old' })
    expect(renameModel(settled({}))).toEqual({ state: 'running', target: 'Old' })
    expect(renameModel(settled({ call: { name: 'rename_workspace', argsRaw: '{"workspa' } }))).toEqual({ state: 'running', target: '' })
  })
  it('carries a refusal in the agent\'s words, or the error code without text', () => {
    const text = [{ type: 'text', text: 'Delorun refused it (conflict): the name "X" is already in use by another workspace' }]
    expect(renameModel(settled({ isError: true, content: text }))).toEqual({ state: 'refused', target: 'Old', reason: text[0]?.text })
    expect(renameModel(settled({ isError: true, error: { name: 'RenameToolError', code: 'WORKSPACE_RENAME_DECLINED' } }))).toMatchObject({ reason: 'WORKSPACE_RENAME_DECLINED' })
    expect(renameModel(settled({ isError: true }))).toMatchObject({ reason: '' })
  })
})

describe('the rename_workspace row', () => {
  it('shows old to new', () => {
    const { container } = show(settled({ meta: { from: 'Old', to: 'New' } }))
    expect(container.textContent).toBe('Rename workspaceOld→New')
    expect(container.querySelector('[data-state="ok"]')).not.toBeNull()
  })
  it('shows the refusal', () => {
    show(settled({ isError: true, content: [{ type: 'text', text: 'Delorun refused it (conflict): taken' }] }))
    expect(screen.getByRole('status').textContent).toBe('Not renamed: Delorun refused it (conflict): taken')
  })
  it('shows the unchanged name and the running call', () => {
    expect(show(settled({ meta: { from: 'A', to: 'A' } })).container.textContent).toBe('Rename workspaceA (already named so)')
    cleanup()
    expect(show(running).container.textContent).toBe('Rename workspaceOld')
  })
  it('shows only the title while the call is being prepared', () => {
    const { container } = render(<RenameRow {...{ phase: 'preparing', t } as RenameRowProps} />)
    expect(container.textContent).toBe(en['rename.title'])
  })
  it('has Chinese copy with the same placeholders', () => {
    for (const key of ['rename.same', 'rename.refused'] as const) expect(zh[key].match(/\{\w+\}/g)).toEqual(en[key].match(/\{\w+\}/g))
  })
})
