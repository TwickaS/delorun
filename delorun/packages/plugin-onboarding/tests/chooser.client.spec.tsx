// @vitest-environment jsdom
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FolderChooser } from '../src/client/FolderChooser.tsx'
import { en } from '../src/client/locales.ts'
import type { AddOutcome } from '../src/client/types.ts'
import { browseFake, HOME, listingOf, startFace, stepServices } from './fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const settle = async () => { await act(async () => { for (let n = 0; n < 4; n++) await Promise.resolve() }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }); await settle() }
const key = async (element: HTMLElement, name: string) => { await act(async () => { fireEvent.keyDown(element, { key: name }) }); await settle() }
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const option = (name: string) => screen.getByRole('option', { name })
const list = () => screen.getByRole('listbox')
const names = () => within(list()).queryAllByRole('option').map(each => each.textContent)

/** The listings of a small home: two folders in it, one with a folder of its own. */
const LISTINGS: Readonly<Record<string, DirectoryListing>> = {
  [HOME]: listingOf(HOME, ['.config', 'notes', 'projects']),
  [`${HOME}/projects`]: listingOf(`${HOME}/projects`, ['site']),
  '/home': listingOf('/home', ['person']),
  '/': listingOf('/', ['home']),
}

/** The chooser over a fake host, adding with the given outcome. */
async function mountChooser(options: { readonly listings?: Readonly<Record<string, DirectoryListing>>; readonly outcome?: AddOutcome } = {}) {
  const start = startFace({ kind: 'none' }, { kind: 'in-step' }, options.outcome)
  const folders = browseFake(options.listings ?? LISTINGS)
  const onAdded = vi.fn()
  const view = render(<FolderChooser services={stepServices({ start: { ...start.face, browse: folders.browse } })} onAdded={onAdded} />)
  await settle()
  return { ...view, start, folders, onAdded }
}

describe('the Start step\'s own folder chooser', () => {
  it('opens at the home directory with nothing selected, so it cannot add the folder it opened in', async () => {
    const { folders, start } = await mountChooser()
    expect(folders.list).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal))
    expect(screen.getByRole('listbox', { name: 'Folders in person' })).toBeTruthy()
    expect(document.body.textContent).toContain(HOME)
    expect(names()).toEqual(['notes', 'projects'])
    expect(within(list()).getAllByRole('option').map(each => each.getAttribute('aria-selected'))).toEqual(['false', 'false'])
    expect([button(en['chooser.add']).disabled, button(en['chooser.open']).disabled]).toEqual([true, true])
    await click(button(en['chooser.add']))
    expect(start.addFolder).not.toHaveBeenCalled()
  })

  it('adds the folder the person selected through the route, and passes the workspace on', async () => {
    const { start, onAdded } = await mountChooser()
    await click(option('projects'))
    expect(option('projects').getAttribute('aria-selected')).toBe('true')
    expect(button(en['chooser.add']).disabled).toBe(false)
    await click(button(en['chooser.add']))
    expect(start.addFolder).toHaveBeenCalledExactlyOnceWith(`${HOME}/projects`)
    expect(onAdded).toHaveBeenCalledExactlyOnceWith({ kind: 'chosen', workspaceId: 'workspace-2', path: `${HOME}/projects`, folder: 'code' })
  })

  it.each<readonly [string, AddOutcome, string]>([
    ['the home directory', { kind: 'refused', problem: 'home-directory' }, en['problem.home-directory']],
    ['a folder holding Delorun\'s home', { kind: 'refused', problem: 'contains-delorun-home' }, en['problem.contains-delorun-home']],
    ['a folder it cannot add', { kind: 'failed' }, en['problem.failed']],
  ])('says why it did not add %s, and clears the reason when another folder is selected', async (_, outcome, text) => {
    const { onAdded } = await mountChooser({ outcome })
    await click(option('notes'))
    await click(button(en['chooser.add']))
    expect(screen.getByRole('alert').textContent).toBe(text)
    expect(onAdded).not.toHaveBeenCalled()
    expect(button(en['chooser.add']).disabled).toBe(false)
    await click(option('projects'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('disables its button while the folder is being added', async () => {
    const { start } = await mountChooser()
    let finish: (outcome: AddOutcome) => void = () => {}
    start.addFolder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await click(option('notes'))
    await click(button(en['chooser.add']))
    expect(button(en['chooser.add']).disabled).toBe(true)
    await act(async () => { finish({ kind: 'failed' }) })
    expect(button(en['chooser.add']).disabled).toBe(false)
  })

  it.each<readonly [string, (target: HTMLElement) => Promise<void>]>([
    ['a double click', target => act(async () => { fireEvent.doubleClick(target) })],
    ['Enter', target => key(target, 'Enter')],
    ['the right arrow', target => key(target, 'ArrowRight')],
    ['the Open folder button', async (target) => { await click(target); await click(button(en['chooser.open'])) }],
  ])('enters a folder with %s, with nothing selected there and the keyboard kept in the list', async (_, enter) => {
    const { folders } = await mountChooser()
    const projects = option('projects')
    projects.focus()
    await enter(projects)
    await settle()
    expect(folders.list).toHaveBeenLastCalledWith(`${HOME}/projects`, expect.any(AbortSignal))
    expect(screen.getByRole('listbox', { name: 'Folders in projects' })).toBeTruthy()
    expect(names()).toEqual(['site'])
    expect(option('site').getAttribute('aria-selected')).toBe('false')
    expect(button(en['chooser.add']).disabled).toBe(true)
    expect(document.activeElement).toBe(option('site'))
  })

  it('goes up with its button and with the left arrow, and not past the filesystem root', async () => {
    const { folders } = await mountChooser()
    await click(button(en['chooser.up']))
    expect(folders.list).toHaveBeenLastCalledWith('/home', expect.any(AbortSignal))
    expect(names()).toEqual(['person'])
    await key(option('person'), 'ArrowLeft')
    expect(folders.list).toHaveBeenLastCalledWith('/', expect.any(AbortSignal))
    expect(button(en['chooser.up']).disabled).toBe(true)
    const calls = folders.list.mock.calls.length
    await key(option('home'), 'ArrowLeft')
    expect(folders.list).toHaveBeenCalledTimes(calls)
  })

  it('moves and selects with the arrow keys, Home and End, selects with Space, and keeps one tab stop', async () => {
    await mountChooser({ listings: { [HOME]: listingOf(HOME, ['a', 'b', 'c']) } })
    const [a, b, c] = within(list()).getAllByRole('option') as [HTMLElement, HTMLElement, HTMLElement]
    expect([a.tabIndex, b.tabIndex, c.tabIndex]).toEqual([0, -1, -1])
    a.focus()
    await key(a, 'ArrowDown')
    expect([document.activeElement, b.getAttribute('aria-selected')]).toEqual([b, 'true'])
    expect([a.tabIndex, b.tabIndex]).toEqual([-1, 0])
    await key(b, 'End')
    expect([document.activeElement, c.getAttribute('aria-selected')]).toEqual([c, 'true'])
    await key(c, 'ArrowDown')
    expect(document.activeElement).toBe(c)
    await key(c, 'Home')
    expect([document.activeElement, a.getAttribute('aria-selected')]).toEqual([a, 'true'])
    await key(a, 'ArrowUp')
    expect(document.activeElement).toBe(a)
    await click(c)
    await key(b, ' ')
    expect(b.getAttribute('aria-selected')).toBe('true')
  })

  it('ignores other keys, and keys that do not come from a folder', async () => {
    const { folders } = await mountChooser()
    await key(option('notes'), 'x')
    await key(list(), 'ArrowDown')
    expect(within(list()).getAllByRole('option').every(each => each.getAttribute('aria-selected') === 'false')).toBe(true)
    expect(folders.list).toHaveBeenCalledOnce()
  })

  it('creates a folder in the folder it shows and selects it, ready to add', async () => {
    const listings = { ...LISTINGS }
    const { folders, start } = await mountChooser({ listings })
    await click(button(en['chooser.new']))
    expect(button(en['chooser.new']).disabled).toBe(true)
    const field = screen.getByLabelText(en['chooser.newName'])
    expect(button(en['chooser.create']).disabled).toBe(true)
    await act(async () => { fireEvent.submit(field.closest('form') as HTMLFormElement) })
    expect(folders.create).not.toHaveBeenCalled()
    await act(async () => { fireEvent.change(field, { target: { value: '  work ' } }) })
    listings[HOME] = listingOf(HOME, ['notes', 'projects', 'work'])
    await click(button(en['chooser.create']))
    expect(folders.create).toHaveBeenCalledExactlyOnceWith(HOME, 'work')
    expect(screen.queryByLabelText(en['chooser.newName'])).toBeNull()
    expect(option('work').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(option('work'))
    await click(button(en['chooser.add']))
    expect(start.addFolder).toHaveBeenCalledExactlyOnceWith(`${HOME}/work`)
  })

  it('says when a folder cannot be created, keeps the name, and closes the form on Cancel', async () => {
    const { folders } = await mountChooser()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    folders.create.mockRejectedValueOnce(new Error('exists'))
    await click(button(en['chooser.new']))
    await act(async () => { fireEvent.change(screen.getByLabelText(en['chooser.newName']), { target: { value: 'notes' } }) })
    await click(button(en['chooser.create']))
    expect(screen.getByRole('alert').textContent).toBe(en['chooser.createFailed'])
    expect((screen.getByLabelText(en['chooser.newName']) as HTMLInputElement).value).toBe('notes')
    await click(button(en['chooser.cancel']))
    expect(screen.queryByLabelText(en['chooser.newName'])).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says when a folder cannot be listed, and lists it again on Try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const folders = browseFake(LISTINGS)
    folders.list.mockRejectedValueOnce(new Error('EACCES'))
    const start = startFace({ kind: 'none' })
    render(<FolderChooser services={stepServices({ start: { ...start.face, browse: folders.browse } })} onAdded={vi.fn()} />)
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['chooser.listFailed'])
    expect(screen.getByRole('listbox', { name: 'Folders in' }).getAttribute('aria-busy')).toBe('true')
    expect(warn).toHaveBeenCalledOnce()
    await click(button(en['chooser.retry']))
    expect(folders.list).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(names()).toEqual(['notes', 'projects'])
  })

  it('says a folder holds no folders, and that a long list was cut', async () => {
    await mountChooser({ listings: { [HOME]: listingOf(HOME, ['.hidden']) } })
    expect(document.body.textContent).toContain(en['chooser.empty'])
    cleanup()
    await mountChooser({ listings: { [HOME]: listingOf(HOME, ['a'], true) } })
    expect(document.body.textContent).toContain(en['chooser.truncated'])
    expect(document.body.textContent).not.toContain(en['chooser.empty'])
  })

  it('names the list after the folder\'s path where the host gives no ancestors', async () => {
    await mountChooser({ listings: { [HOME]: { ...listingOf(HOME, ['a']), crumbs: [] } } })
    expect(screen.getByRole('listbox', { name: `Folders in ${HOME}` })).toBeTruthy()
    expect(button(en['chooser.up']).disabled).toBe(true)
  })

  it('shows only the newest listing, and drops a listing it no longer waits for', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers: { resolve: (listing: DirectoryListing) => void; reject: (error: Error) => void }[] = []
    const folders = browseFake(LISTINGS)
    const start = startFace({ kind: 'none' })
    render(<FolderChooser services={stepServices({ start: { ...start.face, browse: folders.browse } })} onAdded={vi.fn()} />)
    await settle()
    folders.list.mockImplementation(() => new Promise((resolve, reject) => { answers.push({ resolve, reject }) }))
    await click(option('projects'))
    await click(button(en['chooser.open']))
    await click(button(en['chooser.up']))
    answers[1]?.resolve(listingOf('/home', ['person']))
    await settle()
    answers[0]?.resolve(listingOf(`${HOME}/projects`, ['site']))
    await settle()
    expect(names()).toEqual(['person'])
    await click(button(en['chooser.up']))
    await click(button(en['chooser.up']))
    answers[3]?.resolve(listingOf('/', ['home']))
    answers[2]?.reject(new Error('late'))
    await settle()
    expect(names()).toEqual(['home'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stops a listing in flight when it closes', async () => {
    const folders = browseFake(LISTINGS)
    let signal: AbortSignal | undefined
    folders.list.mockImplementationOnce((_path, given) => { signal = given; return new Promise(() => {}) })
    const start = startFace({ kind: 'none' })
    const view = render(<FolderChooser services={stepServices({ start: { ...start.face, browse: folders.browse } })} onAdded={vi.fn()} />)
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('picks a folder instead of adding one: the selected folder, or the one shown when none is selected', async () => {
    const start = startFace({ kind: 'none' })
    const folders = browseFake(LISTINGS)
    const onPick = vi.fn()
    render(<FolderChooser services={stepServices({ start: { ...start.face, browse: folders.browse } })} pick={{ label: 'Clone here', onPick }} />)
    await settle()
    expect(screen.queryByRole('button', { name: en['chooser.add'] })).toBeNull()
    await click(button('Clone here'))
    expect(onPick).toHaveBeenLastCalledWith(HOME)
    await click(option('projects'))
    await click(button('Clone here'))
    expect(onPick).toHaveBeenLastCalledWith(`${HOME}/projects`)
    expect(start.addFolder).not.toHaveBeenCalled()
  })

  it('adds without telling anyone when it has no one to tell', async () => {
    const start = startFace({ kind: 'none' })
    render(<FolderChooser services={stepServices({ start: { ...start.face, browse: browseFake(LISTINGS).browse } })} />)
    await settle()
    await click(option('projects'))
    await click(button(en['chooser.add']))
    expect(start.addFolder).toHaveBeenCalledOnce()
  })
})
