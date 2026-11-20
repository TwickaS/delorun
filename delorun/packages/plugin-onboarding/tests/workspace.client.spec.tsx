// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createGuide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import type { NewWorkspaceOutcome, StartTarget } from '../src/client/types.ts'
import { WorkspaceStep } from '../src/client/steps/Workspace.tsx'
import { DEFAULT_PATH, pathText, DEFAULT_WORKSPACE, HOME, hostFake, startFace, stepServices } from './fixtures.client.ts'

afterEach(cleanup)

const settle = async () => { await act(async () => { for (let n = 0; n < 4; n++) await Promise.resolve() }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }); await settle() }
const radio = (name: string) => screen.getByRole('radio', { name })
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const DEFAULT: StartTarget = { kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH }
const CREATED: NewWorkspaceOutcome = { kind: 'created', workspaceId: 'workspace-2', path: `${HOME}/app`, folder: 'code' }

/** The step over a faked harness and workspace face. */
function mount(options: { readonly target?: StartTarget; readonly outcome?: NewWorkspaceOutcome | 'absent'; readonly keepCurrent?: boolean } = {}) {
  const target = options.target ?? DEFAULT
  const start = startFace(target, options.outcome)
  const guide = createGuide(hostFake().host)
  const view = render(<WorkspaceStep services={stepServices({ start: start.face })} guide={guide} target={target} keepCurrent={options.keepCurrent ?? false} />)
  return { ...view, start, guide }
}

describe('the workspace step', () => {
  it('offers the default workspace or another workspace, with the default shown first', () => {
    mount()
    expect(screen.getAllByRole('radio').map(each => [each.textContent, each.getAttribute('aria-checked')])).toEqual([
      [en['workspace.mode.default'], 'true'], [en['workspace.mode.another'], 'false'],
    ])
    expect(screen.getByText(pathText(DEFAULT_PATH))).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['workspace.new'] })).toBeNull()
  })

  it('says what a workspace is for beside the default, with an example folder for each kind', async () => {
    mount()
    const about = screen.getByRole('region', { name: en['workspace.about'] })
    expect(within(about).getAllByRole('listitem').map(each => each.textContent)).toEqual((['code', 'files', 'empty'] as const).map(kind => `${en[`workspace.about.${kind}.title`]}${en[`workspace.about.${kind}.text`]}${en[`workspace.about.${kind}.sample`]}`))
    await click(radio(en['workspace.mode.another']))
    expect(screen.queryByRole('region', { name: en['workspace.about'] })).toBeNull()
  })

  it('chooses the default workspace again when the person comes back to it', async () => {
    const { guide } = mount()
    await click(radio(en['workspace.mode.another']))
    expect(screen.queryByText(pathText(DEFAULT_PATH))).toBeNull()
    await click(radio(en['workspace.mode.default']))
    expect(guide.workspace.getSnapshot()).toEqual({ kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH })
  })

  it.each<readonly [string, StartTarget, string]>([
    ['is still looked up', { kind: 'checking' }, en['start.lead.checking']],
    ['does not exist', { kind: 'none' }, en['start.lead.none']],
    ['is missing but other workspaces exist', { kind: 'other' }, en['workspace.other']],
  ])('leaves the default out and says so while it %s', (_, target, text) => {
    mount({ target })
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByRole('radio', { name: en['workspace.mode.default'] })).toBeNull()
    expect(radio(en['workspace.mode.another']).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the chat in the current workspace unless the person chooses the default', async () => {
    const { guide } = mount({ keepCurrent: true })
    expect(screen.getByText(en['workspace.keep'])).toBeTruthy()
    await click(button(en['workspace.useDefault']))
    expect(guide.workspace.getSnapshot()).toEqual({ kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH })
    expect(screen.queryByText(en['workspace.keep'])).toBeNull()
  })
})

describe('making another workspace', () => {
  it('opens the new-workspace dialog once for the button, and shows what it says about the choice', async () => {
    const { start } = mount()
    await click(radio(en['workspace.mode.another']))
    expect(screen.getByText(en['workspace.new.note'])).toBeTruthy()
    expect(start.openNewWorkspace).not.toHaveBeenCalled()
    await click(button(en['workspace.new']))
    expect(start.openNewWorkspace).toHaveBeenCalledOnce()
  })

  it('chooses the workspace the dialog made and shows its folder card with what the folder holds', async () => {
    const { guide } = mount({ outcome: CREATED })
    await click(radio(en['workspace.mode.another']))
    await click(button(en['workspace.new']))
    expect(guide.workspace.getSnapshot()).toEqual({ kind: 'added', workspaceId: 'workspace-2', path: `${HOME}/app`, folder: 'code' })
    expect(screen.getByRole('heading', { name: 'app' })).toBeTruthy()
    expect(document.body.textContent).toContain(`${HOME}/app${en['workspace.kind.code']}`)
    expect(screen.queryByText(en['workspace.new.note'])).toBeNull()
    expect(button(en['workspace.new.another']).disabled).toBe(false)
  })

  it('opens the dialog again from Choose another and takes its new choice', async () => {
    const { guide, start } = mount({ outcome: CREATED })
    await click(radio(en['workspace.mode.another']))
    await click(button(en['workspace.new']))
    start.openNewWorkspace.mockResolvedValueOnce({ kind: 'created', workspaceId: 'workspace-3', path: `${HOME}/notes`, folder: 'files' })
    await click(button(en['workspace.new.another']))
    expect(start.openNewWorkspace).toHaveBeenCalledTimes(2)
    expect(guide.workspace.getSnapshot()).toEqual({ kind: 'added', workspaceId: 'workspace-3', path: `${HOME}/notes`, folder: 'files' })
    expect(document.body.textContent).toContain(`${HOME}/notes${en['workspace.kind.files']}`)
  })

  it('changes nothing when the dialog is cancelled', async () => {
    const { guide } = mount({ target: { kind: 'none' } })
    await click(button(en['workspace.new']))
    expect(guide.workspace.getSnapshot()).toBeUndefined()
    expect(screen.queryByRole('heading', { name: 'app' })).toBeNull()
    expect(button(en['workspace.new']).disabled).toBe(false)
  })

  it('is busy while the dialog is open and free again when it ends', async () => {
    const { start, guide } = mount({ target: { kind: 'none' } })
    let end: (outcome: NewWorkspaceOutcome) => void = () => {}
    start.openNewWorkspace.mockImplementationOnce(() => new Promise<NewWorkspaceOutcome>((resolve) => { end = resolve }))
    await click(button(en['workspace.new']))
    expect(button(en['workspace.new']).disabled).toBe(true)
    expect(button(en['workspace.new']).getAttribute('aria-busy')).toBe('true')
    await click(button(en['workspace.new']))
    expect(start.openNewWorkspace).toHaveBeenCalledOnce()
    await act(async () => { end(CREATED) })
    await settle()
    expect(guide.workspace.getSnapshot()).toMatchObject({ kind: 'added', workspaceId: 'workspace-2' })
    expect(button(en['workspace.new.another']).disabled).toBe(false)
  })

  it('says a folder can be added later, and offers no button, where the profile has no new-workspace dialog', async () => {
    const { guide } = mount({ target: { kind: 'none' }, outcome: 'absent' })
    expect(screen.getByText(en['workspace.new.later'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['workspace.new'] })).toBeNull()
    expect(guide.workspace.getSnapshot()).toBeUndefined()
  })

  it('still continues with the default workspace where the profile has no new-workspace dialog', async () => {
    const { guide } = mount({ outcome: 'absent' })
    expect(guide.workspace.getSnapshot()).toBeUndefined()
    await click(radio(en['workspace.mode.another']))
    expect(screen.getByText(en['workspace.new.later'])).toBeTruthy()
    await click(radio(en['workspace.mode.default']))
    expect(guide.workspace.getSnapshot()).toEqual({ kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH })
  })
})
