// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createGuide, type Guide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import type { CloneStartOutcome, FolderChoice, HostFace, StartTarget } from '../src/client/types.ts'
import { cloneProblemText, WorkspaceStep } from '../src/client/WorkspaceStep.tsx'
import { CLONE_FAILURES, CLONE_PROBLEMS, type CloneStatus } from '../src/wire.ts'
import { DEFAULT_PATH, DEFAULT_WORKSPACE, HOME, hostFake, startFace, stepServices } from './fixtures.client.ts'

afterEach(cleanup)

const settle = async () => { await act(async () => { for (let n = 0; n < 4; n++) await Promise.resolve() }) }
const wait = async (ms: number) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }); await settle() }
const type = async (label: string, value: string) => { await act(async () => { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }) }
const radio = (name: string) => screen.getByRole('radio', { name })
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const DEFAULT: StartTarget = { kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH }

/** The step over a faked harness and workspace face. */
function mount(options: { readonly target?: StartTarget; readonly choice?: FolderChoice; readonly host?: HostFace; readonly guide?: Guide } = {}) {
  const start = startFace(options.target ?? DEFAULT, options.choice)
  const guide = options.guide ?? createGuide(options.host ?? hostFake().host, 1)
  const view = render(<WorkspaceStep services={stepServices({ start: start.face })} guide={guide} target={options.target ?? DEFAULT} />)
  return { ...view, start, guide }
}

describe('the workspace step', () => {
  it('offers the default workspace, a folder or a clone, with the default shown first', () => {
    mount()
    expect(screen.getAllByRole('radio').map(each => [each.textContent, each.getAttribute('aria-checked')])).toEqual([
      [en['workspace.mode.default'], 'true'], [en['workspace.mode.folder'], 'false'], [en['workspace.mode.clone'], 'false'],
    ])
    expect(screen.getByText(DEFAULT_PATH)).toBeTruthy()
  })

  it('chooses the default workspace again when the person comes back to it', async () => {
    const { guide } = mount()
    await click(radio(en['workspace.mode.folder']))
    expect(screen.queryByText(DEFAULT_PATH)).toBeNull()
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
    expect(radio(en['workspace.mode.folder']).getAttribute('aria-checked')).toBe('true')
  })

  it('adds a folder the host\'s chooser picked and shows what it holds', async () => {
    const { start, guide } = mount({ choice: { kind: 'chosen', workspaceId: 'workspace-2' as WorkspaceId, path: `${HOME}/app`, folder: 'code' } })
    await click(radio(en['workspace.mode.folder']))
    await click(button(en['workspace.folder.choose']))
    expect(start.chooseFolder).toHaveBeenCalledOnce()
    expect(guide.workspace.getSnapshot()).toEqual({ kind: 'added', workspaceId: 'workspace-2', path: `${HOME}/app`, folder: 'code' })
    expect(screen.getByRole('status').textContent).toBe(`${en['workspace.chosen']}${HOME}/app${en['workspace.kind.code']}`)
  })

  it('shows its own chooser where the host has none, and chooses the folder it adds', async () => {
    const { start, guide } = mount({ target: { kind: 'none' }, choice: { kind: 'in-step' } })
    await click(button(en['workspace.folder.choose']))
    expect(screen.queryByRole('button', { name: en['workspace.folder.choose'] })).toBeNull()
    await settle()
    await click(screen.getByRole('option', { name: 'projects' }))
    await click(button(en['chooser.add']))
    expect(start.addFolder).toHaveBeenCalledExactlyOnceWith(`${HOME}/projects`)
    expect(guide.workspace.getSnapshot()).toEqual({ kind: 'added', workspaceId: 'workspace-2', path: `${HOME}/projects`, folder: 'code' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it.each<readonly [string, FolderChoice, string | undefined]>([
    ['refuses a folder Delorun never adds', { kind: 'refused', problem: 'home-directory' }, en['problem.home-directory']],
    ['cannot add the folder', { kind: 'failed' }, en['problem.failed']],
    ['has no workspace navigation', { kind: 'unavailable' }, en['workspace.folder.unavailable']],
    ['closes the chooser', { kind: 'cancelled' }, undefined],
  ])('keeps the step open when the host %s', async (_, choice, text) => {
    const { guide } = mount({ target: { kind: 'none' }, choice })
    await click(button(en['workspace.folder.choose']))
    if (text !== undefined) expect(screen.getByText(text)).toBeTruthy()
    expect(guide.workspace.getSnapshot()).toBeUndefined()
    expect(button(en['workspace.folder.choose']).disabled).toBe(false)
  })
})

describe('cloning from the workspace step', () => {
  /** Open the clone form, pick the home folder to clone into and type an address. */
  async function cloneForm(options: { readonly cloneStart?: CloneStartOutcome; readonly cloneStatus?: readonly CloneStatus[]; readonly url?: string; readonly pollMs?: number } = {}) {
    const host = hostFake(options)
    const mounted = mount({ guide: createGuide(host.host, options.pollMs ?? 1) })
    await click(radio(en['workspace.mode.clone']))
    await click(button(en['clone.parent.choose']))
    await settle()
    await click(button(en['clone.parent.here']))
    await type(en['clone.url'], options.url ?? 'https://github.com/owner/site.git')
    return { ...mounted, host }
  }

  it('suggests the folder name from the address until the person types one, and clones into the chosen folder', async () => {
    const { host } = await cloneForm()
    expect(screen.getByText(HOME)).toBeTruthy()
    expect((screen.getByLabelText(en['clone.name']) as HTMLInputElement).value).toBe('site')
    await type(en['clone.name'], 'my-site')
    await type(en['clone.url'], 'git@github.com:owner/other.git')
    expect((screen.getByLabelText(en['clone.name']) as HTMLInputElement).value).toBe('my-site')
    expect(screen.getByText(/never asks for a password here/)).toBeTruthy()
    await click(button(en['clone.start']))
    expect(host.cloneStart).toHaveBeenCalledExactlyOnceWith({ url: 'git@github.com:owner/other.git', parent: HOME, name: 'my-site' })
  })

  it('says what is wrong with the form and starts nothing until it is right', async () => {
    const host = hostFake()
    mount({ host: host.host })
    await click(radio(en['workspace.mode.clone']))
    await type(en['clone.url'], '-uploadpack=touch')
    expect(screen.queryByText(en['clone.problem.url-form'])).toBeNull()
    await act(async () => { fireEvent.blur(screen.getByLabelText(en['clone.url'])) })
    expect(screen.getByText(en['clone.problem.url-form'])).toBeTruthy()
    expect(screen.getByLabelText(en['clone.url']).getAttribute('aria-invalid')).toBe('true')
    await click(button(en['clone.start']))
    expect(screen.getByText(en['clone.parent.missing'])).toBeTruthy()
    expect(screen.getByText(en['clone.problem.name-form'])).toBeTruthy()
    await type(en['clone.url'], 'https://github.com/owner/site.git')
    await type(en['clone.name'], '../escape')
    await click(button(en['clone.start']))
    expect(host.cloneStart).not.toHaveBeenCalled()
  })

  it('leaves an address the person has not finished alone until it loses focus', async () => {
    mount()
    await click(radio(en['workspace.mode.clone']))
    await act(async () => { fireEvent.blur(screen.getByLabelText(en['clone.url'])) })
    expect(screen.queryByText(en['clone.problem.url-form'])).toBeNull()
  })

  it('shows the progress Git reports and chooses the cloned folder once it is added', async () => {
    const { guide } = await cloneForm({ cloneStatus: [
      { state: 'running' },
      { state: 'running', percent: 42 },
      { state: 'done', workspaceId: 'workspace-3', path: `${HOME}/site`, kind: 'code' },
    ], pollMs: 40 })
    await click(button(en['clone.start']))
    expect(button(en['clone.start']).disabled).toBe(true)
    expect((screen.getByLabelText(en['clone.url']) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(en['clone.running'])).toBeTruthy()
    await wait(150)
    expect(guide.workspace.getSnapshot()).toEqual({ kind: 'added', workspaceId: 'workspace-3', path: `${HOME}/site`, folder: 'code' })
    expect(screen.getByRole('status').textContent).toContain(`${HOME}/site`)
    expect(button(en['clone.start']).disabled).toBe(false)
  })

  it('says the clone is starting until the harness answers', async () => {
    const host = hostFake()
    host.cloneStart.mockImplementation(() => new Promise(() => {}))
    mount({ host: host.host })
    await click(radio(en['workspace.mode.clone']))
    await click(button(en['clone.parent.choose']))
    await settle()
    await click(button(en['clone.parent.here']))
    await type(en['clone.url'], 'https://github.com/owner/site.git')
    await click(button(en['clone.start']))
    expect(screen.getByText(en['clone.starting'])).toBeTruthy()
  })

  it('shows Git\'s percent while it runs', async () => {
    await cloneForm({ cloneStatus: [{ state: 'running', percent: 42 }] })
    await click(button(en['clone.start']))
    await wait(5)
    expect(screen.getByText('Cloning… 42%')).toBeTruthy()
    expect((document.querySelector('progress') as HTMLProgressElement).value).toBe(42)
  })

  it.each(CLONE_FAILURES.map(failure => [failure] as const))('says why a clone failed with %s', async (failure) => {
    await cloneForm({ cloneStatus: [{ state: 'failed', failure }] })
    await click(button(en['clone.start']))
    await wait(5)
    expect(screen.getByRole('alert').textContent).toBe(en[`clone.failure.${failure}`])
    expect(button(en['clone.start']).disabled).toBe(false)
  })

  it.each(CLONE_PROBLEMS.map(problem => [problem] as const))('says why a clone refused as %s did not start', async (problem) => {
    await cloneForm({ cloneStart: { kind: 'refused', problem } })
    await click(button(en['clone.start']))
    expect(screen.getByRole('alert').textContent).toBe(cloneProblemText(stepServices().t, problem))
  })

  it('words the clone-only refusals itself and the location refusals as adding a folder does', () => {
    const { t } = stepServices()
    expect(cloneProblemText(t, 'busy')).toBe(en['clone.problem.busy'])
    expect(cloneProblemText(t, 'delorun-home')).toBe(en['problem.delorun-home'])
  })
})
