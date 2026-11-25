// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { NewWorkspaceDialog } from '../src/client/NewWorkspaceDialog.tsx'
import type { NewWorkspaceApi } from '../src/client/api.ts'
import type { FolderListing } from '../src/client/screens/FolderScreen.tsx'
import type { FullAccessAsk } from '../src/client/create.ts'
import type { ModelCatalogView } from '../src/client/models.ts'
import type { PreviewAnswer } from '../src/wire.ts'
import { CATALOG, failure, fakeApi, fakeBrowse, fakeBrowser, fakeFullAccess, HOME, listingOf, NOW, ok, PLACES, t } from './fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const settle = async () => { await act(async () => { for (let n = 0; n < 6; n++) await Promise.resolve() }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }); await settle() }
const type = async (element: HTMLElement, value: string) => { await act(async () => { fireEvent.change(element, { target: { value } }) }); await settle() }
const key = async (element: HTMLElement, name: string) => { await act(async () => { fireEvent.keyDown(element, { key: name }) }); await settle() }
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement
/** The path the folder summary says it would use. */
const selectedPath = () => within(screen.getByRole('region')).getByText(/^~/).textContent
const heading = () => screen.getByRole('heading', { level: 2 }).textContent
/** The folder names of a list, without the hints under them. */
const folderNames = (list: HTMLElement) => within(list).getAllByRole('option').map(each => each.querySelector('[id$="n"]')?.textContent)

interface Options {
  readonly api?: Partial<NewWorkspaceApi>
  readonly listings?: Readonly<Record<string, FolderListing>>
  readonly wait?: (ms: number) => Promise<void>
  /** The catalogue the studio answers; null when it cannot be read. */
  readonly catalog?: ModelCatalogView | null
  readonly fullAccess?: FullAccessAsk
}

/** The dialog over a fake Host, at the first screen once the places have been read. */
async function mount(options: Options = {}) {
  const fake = fakeApi(options.api)
  const folders = fakeBrowse(options.listings)
  const onClose = vi.fn()
  const onCreated = vi.fn()
  const access = fakeFullAccess()
  const shown = fakeBrowser()
  const readModels = vi.fn(async () => options.catalog === null ? undefined : options.catalog ?? CATALOG)
  render(<NewWorkspaceDialog t={t} api={fake.api} browse={folders.browse} readModels={readModels} fullAccess={options.fullAccess ?? access.fullAccess} browser={shown.browser}
    from="sidebar" onClose={onClose} onCreated={onCreated} wait={options.wait ?? (async () => {})} now={() => NOW} />)
  await settle()
  return { ...fake, folders, onClose, onCreated, askFullAccess: access.ask }
}

/** Choose a card on the first screen and go on. */
async function start(card: RegExp) {
  await click(button(card))
  await click(button(en.continue))
}

describe('the first screen', () => {
  it('asks how to start with three cards, the step count and the recent workspaces', async () => {
    await mount()
    expect(heading()).toBe('New workspace')
    expect(screen.getByText('Step 1 of 5')).toBeTruthy()
    expect(screen.getByText(en['how.title'])).toBeTruthy()
    for (const card of [/^New folder/, /^Folder on this computer/, /^Clone from Git/]) expect(button(card)).toBeTruthy()
    expect(screen.getByText(en['how.new.body'])).toBeTruthy()
    const recent = within(screen.getByRole('region', { name: en['how.recent'] }))
    expect(recent.getAllByRole('button').map(each => each.textContent)).toEqual([
      'delorun~/src/delorun2 days ago',
      'tax-2026~/Documents/tax-2026Last week',
    ])
  })

  it('goes on only once a card is chosen, to that card\'s screen in step 2', async () => {
    await mount()
    expect(button(en.continue).disabled).toBe(true)
    await click(button(/^Clone from Git/))
    expect(button(/^Clone from Git/).getAttribute('aria-pressed')).toBe('true')
    await click(button(en.continue))
    expect(heading()).toBe('New workspace · Clone from Git')
    expect(screen.getByText('Step 2 of 5')).toBeTruthy()
  })

  it('does not let a card be chosen before the places are read', async () => {
    const never = new Promise<never>(() => {})
    await mount({ api: { places: () => never } })
    await click(button(/^New folder/))
    expect(button(en.continue).disabled).toBe(true)
  })

  it('says why the places could not be read and reads them again on request', async () => {
    const answers = [failure('refused-arrival'), ok(PLACES)]
    const places = vi.fn<NewWorkspaceApi['places']>(async () => answers.shift() ?? failure('failed'))
    await mount({ api: { places } })
    expect(screen.getByRole('alert').textContent).toBe(en['problem.refusedArrival'])
    await click(button(en.retry))
    expect(places).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('region', { name: en['how.recent'] })).toBeTruthy()
  })

  it('closes from Cancel, from the close button and from Escape', async () => {
    const { onClose } = await mount()
    await click(button(en.cancel))
    await click(button(en.close))
    await key(screen.getByRole('dialog'), 'Escape')
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('uses a recent workspace\'s folder at once and reports the workspace', async () => {
    const { add, onCreated } = await mount()
    await click(screen.getByRole('button', { name: /^delorun/ }))
    expect(add).toHaveBeenCalledExactlyOnceWith(`${HOME}/src/delorun`)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1', path: `${HOME}/src/delorun`, folder: 'code' })
  })

  it('shows the reason in place when a recent folder is refused', async () => {
    const { onCreated } = await mount({ api: { add: async () => ok({ result: 'refused', problem: 'delorun-home' }) } })
    await click(screen.getByRole('button', { name: /^delorun/ }))
    expect(screen.getByRole('alert').textContent).toBe(en['problem.delorun-home'])
    expect(heading()).toBe('New workspace')
    expect(onCreated).not.toHaveBeenCalled()
  })
})

describe('a folder on this computer', () => {
  const open = async (options: Options = {}) => {
    const mounted = await mount(options)
    await start(/^Folder on this computer/)
    return mounted
  }

  it('lists the visible folders of the home folder with its crumbs and suggested places, and uses nothing until one is chosen', async () => {
    const { folders } = await open()
    expect(heading()).toBe('New workspace · Choose a folder')
    expect(folders.list).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    const list = screen.getByRole('listbox')
    expect(folderNames(list)).toEqual(['Documents', 'src'])
    expect(within(screen.getByRole('navigation', { name: en['folder.crumbs'] })).getAllByRole('button').map(each => each.textContent)).toEqual([en['folder.home']])
    expect(within(screen.getByRole('group', { name: en['folder.suggested'] })).getAllByRole('button').map(each => each.textContent)).toEqual(['~/src', '~/Documents'])
    expect(button(en['folder.useNone']).disabled).toBe(true)
    expect(document.body.textContent).not.toContain(HOME)
  })

  it('summarises the selected folder: its stack, Git branch and latest commit, AGENTS.md, top-level files with sizes and that there are more', async () => {
    const { preview } = await open()
    await click(screen.getByRole('option', { name: 'src' }))
    expect(await screen.findByText(en['preview.stack.node'])).toBeTruthy()
    expect(screen.getByText(en['preview.stack.typescript'])).toBeTruthy()
    expect(preview).toHaveBeenLastCalledWith(`${HOME}/src`, expect.any(AbortSignal))
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('fix: keep the sidebar open')).toBeTruthy()
    expect(screen.getByText('3 hours ago')).toBeTruthy()
    expect(screen.getByText(en['preview.agents'])).toBeTruthy()
    expect(screen.getByText('README.md').nextElementSibling?.textContent).toBe('1.5 KB')
    expect(screen.getByText('package.json').nextElementSibling?.textContent).toBe('812 B')
    expect(screen.getByText('docs').nextElementSibling).toBeNull()
    expect(screen.getByText(en['preview.more'])).toBeTruthy()
    expect(selectedPath()).toBe('~/src')
    expect(button('Use "src"').disabled).toBe(false)
  })

  it('names the kind of folder when no stack is found, and offers Use this folder in the summary too', async () => {
    const { preview } = await open({ api: { preview: async () => ok({ result: 'folder', kind: 'files', git: false, agentsFile: false, entries: [{ name: 'notes.txt', folder: false, size: 3 }], more: false }) } })
    await click(screen.getByRole('option', { name: 'src' }))
    const pane = within(screen.getByRole('region'))
    expect(await pane.findByText(en['preview.kind.files'])).toBeTruthy()
    expect(pane.queryByText(en['preview.git'])).toBeNull()
    expect(preview).toHaveBeenCalled()
    expect(button('Use "src"').disabled).toBe(false)
    await click(pane.getByRole('button', { name: en['folder.useNone'] }))
    expect(screen.getByRole('heading', { level: 2 }).textContent).not.toBe('New workspace · Choose a folder')
  })

  it('says Git without a branch for a detached HEAD, says an empty folder is empty, and shows a repository without commits', async () => {
    const { preview } = await open({ api: { preview: async () => ok({ result: 'folder', kind: 'code', git: true, agentsFile: false, entries: [], more: false }) } })
    await click(screen.getByRole('option', { name: 'src' }))
    expect(await screen.findByText(en['preview.git'])).toBeTruthy()
    expect(screen.getByText(en['preview.empty'])).toBeTruthy()
    expect(preview).toHaveBeenCalled()
  })

  it('shows the folders as a grid with a hint, and no summary, until a folder is selected', async () => {
    await open()
    const columns = document.querySelector('[data-detail]') as HTMLElement
    expect(columns.dataset.detail).toBe('none')
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.getByText(en['folder.pickHint'])).toBeTruthy()
    await click(screen.getByRole('option', { name: 'src' }))
    expect(columns.dataset.detail).toBe('summary')
    expect(screen.queryByText(en['folder.pickHint'])).toBeNull()
  })

  it('reads each listed folder for a hint under its name: its stack or kind, and its Git branch', async () => {
    const { preview } = await open()
    expect(await screen.findAllByText('Node.js, TypeScript · main')).toHaveLength(2)
    expect(preview).toHaveBeenCalledWith(`${HOME}/Documents`, expect.any(AbortSignal))
    expect(preview).toHaveBeenCalledWith(`${HOME}/src`, expect.any(AbortSignal))
    expect(screen.getByRole('option', { name: 'src' }).getAttribute('aria-describedby')).toBeTruthy()
  })

  it('names the kind of a folder with no known stack and leaves a folder the Host will not read without a hint', async () => {
    const answers: Record<string, PreviewAnswer> = {
      [`${HOME}/Documents`]: { result: 'folder', kind: 'empty', git: false, agentsFile: false, entries: [], more: false },
      [`${HOME}/src`]: { result: 'refused', problem: 'outside-roots' },
    }
    await open({ api: { preview: async path => ok(answers[path] as PreviewAnswer) } })
    expect(await screen.findByText(en['preview.kind.empty'])).toBeTruthy()
    expect(screen.getByRole('option', { name: /^src$/ }).getAttribute('aria-describedby')).toBeNull()
  })

  it('offers New folder as an icon button named for screen readers', async () => {
    await open()
    expect(button(en['folder.newFolder']).textContent).toBe('')
  })

  it('opens a folder with Enter and moves the selection with the arrow keys', async () => {
    const { folders } = await open()
    const list = screen.getByRole('listbox')
    screen.getByRole('option', { name: 'Documents' }).focus()
    await key(screen.getByRole('option', { name: 'Documents' }), 'ArrowDown')
    expect(screen.getByRole('option', { name: 'src' }).getAttribute('aria-selected')).toBe('true')
    await key(screen.getByRole('option', { name: 'src' }), 'Enter')
    expect(folders.list).toHaveBeenLastCalledWith(`${HOME}/src`, expect.any(AbortSignal))
    expect(folderNames(list)).toEqual(['delorun', 'site'])
    expect(within(screen.getByRole('navigation', { name: en['folder.crumbs'] })).getAllByRole('button').map(each => each.textContent)).toEqual([en['folder.home'], 'src'])
    expect(button('Use "src"').disabled).toBe(false)
  })

  it('keeps a long folder name on one line, cut with an ellipsis, and keeps the row compact (#90)', async () => {
    const long = 'delorun-new-home-pre-import-20261123'
    const found = [{ path: `${HOME}/${long}`, name: long }, { path: `${HOME}/delorun`, name: 'delorun' }]
    await open({ api: { search: async () => ok({ results: found, stopped: 'complete' }) } })
    await type(screen.getByRole('textbox', { name: en['folder.search'] }), 'delorun')
    const first = await screen.findByRole('option', { name: new RegExp(`^${long}`) })
    const results = screen.getByRole('listbox', { name: en['folder.results'] })
    const options = within(results).getAllByRole('option')
    expect(options[0]).toBe(first)
    // The name is one line: the rule that lets it wrap to one letter per line is gone.
    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/screens/screens.module.css'), 'utf8')
    const name = /\.folderName\s*\{([^{}]*)\}/.exec(sheet)?.[1] ?? ''
    expect(name).toContain('white-space: nowrap')
    expect(name).toContain('text-overflow: ellipsis')
    expect(name).toContain('min-width: 0')
    expect(name).not.toContain('overflow-wrap: anywhere')
    // The full path is the row's tooltip, so a cut name is still readable.
    expect(options[0]?.getAttribute('title')).toBe(`~/${long}`)
    expect(options[1]?.getAttribute('title')).toBe('~/delorun')
  })

  it('replaces the listing with the search results, selects a result with Enter, and says the list was cut', async () => {
    const found = [{ path: `${HOME}/src/delorun`, name: 'delorun' }, { path: `${HOME}/old/delorun-v2`, name: 'delorun-v2' }]
    const { search } = await open({ api: { search: async () => ok({ results: found, stopped: 'limit' }) } })
    const box = screen.getByRole('textbox', { name: en['folder.search'] })
    await type(box, 'delor')
    expect(screen.getByText(en['folder.looking'])).toBeTruthy()
    await screen.findByRole('option', { name: /^delorun-v2/ })
    const results = screen.getByRole('listbox', { name: en['folder.results'] })
    expect(search).toHaveBeenCalledExactlyOnceWith('delor', expect.any(AbortSignal))
    expect(within(results).getAllByRole('option').map(each => each.textContent)).toEqual(['delorun~/src/delorun', 'delorun-v2~/old/delorun-v2'])
    expect(screen.getByText('Showing the first 50')).toBeTruthy()
    await key(within(results).getAllByRole('option')[1] as HTMLElement, 'Enter')
    expect(button('Use "delorun-v2"').disabled).toBe(false)
    await type(box, '')
    expect(screen.getByRole('listbox', { name: /^Folders in/ })).toBeTruthy()
  })

  it('selects the first result with Enter in the search field, and says when nothing matched or time ran out', async () => {
    const answers = [
      ok({ results: [{ path: `${HOME}/src/site`, name: 'site' }], stopped: 'complete' as const }),
      ok({ results: [], stopped: 'complete' as const }),
      ok({ results: [{ path: `${HOME}/src/sitemap`, name: 'sitemap' }], stopped: 'time' as const }),
    ]
    await open({ api: { search: async () => answers.shift() ?? failure('failed') } })
    const box = screen.getByRole('textbox', { name: en['folder.search'] })
    await type(box, 'site')
    await screen.findByRole('option', { name: /^site/ })
    await key(box, 'Enter')
    expect(button('Use "site"').disabled).toBe(false)
    await type(box, 'zzz')
    expect(await screen.findByText(en['folder.noResults'])).toBeTruthy()
    await type(box, 'sitem')
    expect(await screen.findByText(en['folder.timeUp'])).toBeTruthy()
  })

  it('says in place when the search could not run', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await open({ api: { search: async () => failure('failed') } })
    await type(screen.getByRole('textbox', { name: en['folder.search'] }), 'x')
    expect((await screen.findByText(en['folder.searchFailed'])).getAttribute('role')).toBe('alert')
  })

  it('says why a folder is refused, in one sentence, and does not let it be used', async () => {
    const { add } = await open({ api: { preview: async () => ok({ result: 'refused', problem: 'outside-roots' }) } })
    await click(screen.getByRole('option', { name: 'src' }))
    const sentence = await screen.findByText('Delorun is set to use folders inside your home folder only.')
    expect(sentence.getAttribute('role')).toBe('alert')
    expect(button('Use "src"').disabled).toBe(true)
    await click(button('Use "src"'))
    expect(add).not.toHaveBeenCalled()
  })

  it('has one sentence for every folder Delorun never adds', async () => {
    const { PLACE_PROBLEMS } = await import('../src/wire.ts')
    for (const problem of PLACE_PROBLEMS) expect(en[`problem.${problem}`].length).toBeGreaterThan(10)
    expect(en['problem.home-directory']).toBe('Your home folder holds everything; pick a folder inside it.')
  })

  it('adds the folder it uses, and shows the reason in place when the Host refuses it after all', async () => {
    const answers = [ok({ result: 'refused' as const, problem: 'stock-home' as const }), ok({ result: 'added' as const, workspaceId: 'workspace-9', path: `${HOME}/src`, kind: 'code' as const })]
    const { add, onCreated } = await open({ api: { add: async () => answers.shift() ?? failure('failed') } })
    await click(screen.getByRole('option', { name: 'src' }))
    await click(button('Use "src"'))
    expect(heading()).toBe('New workspace · Browser')
    expect(add).not.toHaveBeenCalled()
    await click(button(en.createNow))
    expect(add).toHaveBeenCalledExactlyOnceWith(`${HOME}/src`)
    expect(heading()).toBe('New workspace · Choose a folder')
    expect(screen.getByRole('alert').textContent).toBe(en['problem.stock-home'])
    expect(onCreated).not.toHaveBeenCalled()
    await click(screen.getByRole('option', { name: 'src' }))
    await click(button('Use "src"'))
    await click(button(en.createNow))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-9', path: `${HOME}/src`, folder: 'code' })
  })

  it('makes a new folder inline, selects it, and refuses a name that is not one plain folder name', async () => {
    const { folders } = await open()
    await click(button(en['folder.newFolder']))
    const name = field(en['folder.newName'])
    await type(name, 'a/b')
    await click(button(en['folder.newCreate']))
    expect(screen.getByRole('alert').textContent).toBe(en['folder.newInvalid'])
    expect(folders.create).not.toHaveBeenCalled()
    await type(name, 'fresh')
    await click(button(en['folder.newCreate']))
    expect(folders.create).toHaveBeenCalledExactlyOnceWith(HOME, 'fresh')
    expect(screen.queryByLabelText(en['folder.newName'])).toBeNull()
    expect(button('Use "fresh"').disabled).toBe(false)
    expect(selectedPath()).toBe('~/fresh')
  })

  it('says in place when the new folder could not be made', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { folders } = await open()
    folders.create.mockRejectedValueOnce(new Error('exists'))
    await click(button(en['folder.newFolder']))
    await type(field(en['folder.newName']), 'fresh')
    await click(button(en['folder.newCreate']))
    expect(screen.getByRole('alert').textContent).toBe(en['folder.newFailed'])
  })

  it('opens a suggested place and a crumb', async () => {
    const { folders } = await open()
    await click(button('~/src'))
    expect(folders.list).toHaveBeenLastCalledWith(`${HOME}/src`, expect.any(AbortSignal))
    await click(within(screen.getByRole('navigation', { name: en['folder.crumbs'] })).getByRole('button', { name: en['folder.home'] }))
    expect(folders.list).toHaveBeenLastCalledWith(HOME, expect.any(AbortSignal))
  })

  it('says in place when the folders cannot be listed, and lists them again on request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { folders } = await open()
    folders.list.mockRejectedValueOnce(new Error('gone'))
    await click(button('~/src'))
    expect(screen.getByText(en['folder.listFailed'])).toBeTruthy()
    await click(button(en.retry))
    expect(screen.queryByText(en['folder.listFailed'])).toBeNull()
  })

  it('goes back to the first screen with its choice kept', async () => {
    await open()
    await click(button(en.back))
    expect(heading()).toBe('New workspace')
    expect(button(/^Folder on this computer/).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('a new folder', () => {
  const open = async (options: Options = {}) => {
    const mounted = await mount(options)
    await start(/^New folder/)
    return mounted
  }

  it('opens prefilled with the default place and Git ticked, and creates nothing until it has a name', async () => {
    await open()
    expect(heading()).toBe('New workspace · New folder')
    expect(screen.getByText('~/Projects')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: en['new.git'] }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(en['new.gitHelp'])).toBeTruthy()
    expect(button(en.continue).disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('checks the name as it is typed and shows where the folder will be made', async () => {
    await open()
    const name = field(en['new.name'])
    await type(name, 'a/b')
    expect(screen.getByRole('alert').textContent).toBe(en['new.nameInvalid'])
    expect(button(en.continue).disabled).toBe(true)
    await type(name, 'my-project')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Will be created as ~/Projects/my-project')).toBeTruthy()
    expect(button(en.continue).disabled).toBe(false)
  })

  it('makes the folder with Git unless the person unticks it, and reports the workspace', async () => {
    const { create, onCreated } = await open()
    await type(field(en['new.name']), 'my-project')
    await click(screen.getByRole('checkbox', { name: en['new.git'] }))
    expect((screen.getByRole('checkbox', { name: en['new.git'] }) as HTMLInputElement).checked).toBe(false)
    await click(button(en.continue))
    expect(create).not.toHaveBeenCalled()
    await click(button(en.createNow))
    expect(create).toHaveBeenCalledExactlyOnceWith({ parent: `${HOME}/Projects`, name: 'my-project', git: false })
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-2', path: `${HOME}/Projects/my-project`, folder: 'empty' })
  })

  it('starts a Git repository by default', async () => {
    const { create } = await open()
    await type(field(en['new.name']), 'tidy')
    await click(button(en.continue))
    await click(button(en.createNow))
    expect(create).toHaveBeenCalledExactlyOnceWith({ parent: `${HOME}/Projects`, name: 'tidy', git: true })
  })

  it('stays on the screen with the reason when something is already there', async () => {
    const { onCreated } = await open({ api: { create: async () => ok({ result: 'refused', problem: 'exists' }) } })
    await type(field(en['new.name']), 'taken')
    await click(button(en.continue))
    await click(button(en.createNow))
    expect(heading()).toBe('New workspace · New folder')
    expect(screen.getByRole('alert').textContent).toBe(en['new.problem.exists'])
    expect(field(en['new.name']).value).toBe('taken')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('asks for an unlock, then lets the person try again', async () => {
    const answers = [failure('locked'), ok({ result: 'added' as const, workspaceId: 'workspace-4', path: `${HOME}/Projects/a`, git: true })]
    const { onCreated } = await open({ api: { create: async () => answers.shift() ?? failure('failed') } })
    await type(field(en['new.name']), 'a')
    await click(button(en.continue))
    await click(button(en.createNow))
    expect(heading()).toBe('New workspace · Browser')
    expect(screen.getByRole('alert').textContent).toBe(en['problem.locked'])
    await click(button(en.createNow))
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('picks another place in the folder browser and returns with it', async () => {
    const { folders } = await open()
    await type(field(en['new.name']), 'my-project')
    await click(button(en['new.change']))
    expect(heading()).toBe('New workspace · Choose a place')
    expect(folders.list).toHaveBeenLastCalledWith(`${HOME}/Projects`, expect.any(AbortSignal))
    expect(button(en['folder.choosePlace']).disabled).toBe(false)
    await click(button('~/src'))
    await click(button(en['folder.choosePlace']))
    expect(heading()).toBe('New workspace · New folder')
    expect(screen.getByText('~/src')).toBeTruthy()
    expect(field(en['new.name']).value).toBe('my-project')
    expect(screen.getByText('Will be created as ~/src/my-project')).toBeTruthy()
  })

  it('comes back from the place picker with the place unchanged', async () => {
    await open()
    await click(button(en['new.change']))
    await click(button(en.back))
    expect(heading()).toBe('New workspace · New folder')
    expect(screen.getByText('~/Projects')).toBeTruthy()
  })

  it('does not offer a place the Host refuses', async () => {
    await open({ api: { preview: async () => ok({ result: 'refused', problem: 'outside-roots' }) } })
    await click(button(en['new.change']))
    await click(button('~/src'))
    await screen.findByText(en['problem.outside-roots'])
    expect(button(en['folder.choosePlace']).disabled).toBe(true)
  })
})

describe('a clone', () => {
  const open = async (options: Options = {}) => {
    const mounted = await mount(options)
    await start(/^Clone from Git/)
    return mounted
  }

  it('opens prefilled with the default place and the private repository note, and starts nothing until the address is usable', async () => {
    await open()
    expect(screen.getByText('~/Projects')).toBeTruthy()
    expect(screen.getByText(en['clone.private'])).toBeTruthy()
    expect(field(en['clone.branch']).placeholder).toBe(en['clone.branchPlaceholder'])
    expect(button(en['clone.start']).disabled).toBe(true)
  })

  it('checks the address, and asks the person to leave a user name and password out', async () => {
    await open()
    const address = field(en['clone.address'])
    await type(address, '/home/person/repo')
    expect(screen.getByRole('alert').textContent).toBe(en['clone.addressInvalid'])
    await type(address, ['https://user', 'token@github.com/acme/site.git'].join(':'))
    expect(screen.getByRole('alert').textContent).toBe('Leave the user name and password out; Delorun uses the sign-in Git has saved.')
    expect(button(en['clone.start']).disabled).toBe(true)
    await type(address, 'https://github.com/acme/site.git')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button(en['clone.start']).disabled).toBe(false)
  })

  it('suggests the folder name from the address until the person edits it', async () => {
    await open()
    const address = field(en['clone.address'])
    await type(address, 'https://github.com/acme/site.git')
    expect(field(en['clone.folderName']).value).toBe('site')
    expect(screen.getByText('Will be cloned to ~/Projects/site')).toBeTruthy()
    await type(address, 'git@github.com:acme/other.git')
    expect(field(en['clone.folderName']).value).toBe('other')
    await type(field(en['clone.folderName']), 'mine')
    await type(address, 'https://github.com/acme/third.git')
    expect(field(en['clone.folderName']).value).toBe('mine')
  })

  it('checks the branch and the folder name', async () => {
    await open()
    await type(field(en['clone.address']), 'https://github.com/acme/site.git')
    await type(field(en['clone.branch']), 'bad branch')
    expect(screen.getByRole('alert').textContent).toBe(en['clone.branchInvalid'])
    expect(button(en['clone.start']).disabled).toBe(true)
    await type(field(en['clone.branch']), 'release/1.0')
    await type(field(en['clone.folderName']), 'a/b')
    expect(screen.getByRole('alert').textContent).toBe(en['clone.nameInvalid'])
    await type(field(en['clone.folderName']), '')
    expect(button(en['clone.start']).disabled).toBe(true)
  })

  /** Fill the form with a usable address, so the clone can start. */
  const fill = async (branch = '') => {
    await type(field(en['clone.address']), 'https://github.com/acme/site.git')
    if (branch !== '') await type(field(en['clone.branch']), branch)
  }

  it('starts the clone without a branch when none is typed, goes on while it runs, shows its progress in the footer once the flow finishes, and reports the workspace when it is added', async () => {
    const statuses = [{ state: 'running' as const, percent: 42 }, { state: 'done' as const, workspaceId: 'workspace-3', path: `${HOME}/Projects/site`, kind: 'code' as const }]
    let release: () => void = () => {}
    const wait = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const { clone, cloneStatus, onCreated } = await open({ api: { cloneStatus: async () => ok(statuses.shift() ?? { state: 'unknown' as const }) }, wait })
    await fill()
    await click(button(en['clone.start']))
    expect(clone).toHaveBeenCalledExactlyOnceWith({ url: 'https://github.com/acme/site.git', parent: `${HOME}/Projects`, name: 'site' })
    expect(heading()).toBe('New workspace · Browser')
    expect(cloneStatus).not.toHaveBeenCalled()
    await click(button(en.createNow))
    expect(screen.getByText('Cloning site · 42 %').textContent).toBe('Cloning site · 42 %')
    expect(button(en.createNow).disabled).toBe(true)
    expect(onCreated).not.toHaveBeenCalled()
    await act(async () => { release() })
    await settle()
    expect(cloneStatus).toHaveBeenCalledTimes(2)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-3', path: `${HOME}/Projects/site`, folder: 'code' })
  })

  it('sends the branch when one is typed', async () => {
    const { clone } = await open()
    await fill('release/1.0')
    await click(button(en['clone.start']))
    expect(clone).toHaveBeenCalledExactlyOnceWith({ url: 'https://github.com/acme/site.git', parent: `${HOME}/Projects`, name: 'site', branch: 'release/1.0' })
  })

  it('shows a refusal in place on this screen, with one sentence per problem, and keeps the form', async () => {
    const { cloneStatus, onCreated } = await open({ api: { clone: async () => ok({ result: 'refused', problem: 'not-empty' }) } })
    await fill()
    await click(button(en['clone.start']))
    expect(screen.getByRole('alert').textContent).toBe(en['clone.problem.not-empty'])
    expect(heading()).toBe('New workspace · Clone from Git')
    expect(field(en['clone.address']).value).toBe('https://github.com/acme/site.git')
    expect(button(en['clone.start']).disabled).toBe(false)
    expect(cloneStatus).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('brings the person back to the clone screen with the reason when the clone fails later', async () => {
    const { onCreated } = await open({ api: { cloneStatus: async () => ok({ state: 'failed', failure: 'not-found' }) } })
    await fill()
    await click(button(en['clone.start']))
    await click(button(en.createNow))
    expect(screen.getByRole('alert').textContent).toBe(en['clone.failure.not-found'])
    expect(heading()).toBe('New workspace · Clone from Git')
    expect(field(en['clone.address']).value).toBe('https://github.com/acme/site.git')
    expect(field(en['clone.address']).disabled).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('stops following the clone when the dialog is closed, and leaves the clone to the Host', async () => {
    const wait = vi.fn(() => new Promise<void>(() => {}))
    const { cloneStatus } = await open({ api: { cloneStatus: async () => ok({ state: 'running' as const }) }, wait })
    await fill()
    await click(button(en['clone.start']))
    await click(button(en.createNow))
    expect(screen.getByText('Cloning site…').textContent).toBe('Cloning site…')
    cleanup()
    await settle()
    expect(cloneStatus).toHaveBeenCalledOnce()
  })

  it('goes on without starting a second clone when the person comes back and changes nothing', async () => {
    const { clone } = await open()
    await fill()
    await click(button(en['clone.start']))
    await click(button(en.back))
    expect(heading()).toBe('New workspace · Clone from Git')
    await click(button(en['clone.start']))
    expect(heading()).toBe('New workspace · Browser')
    expect(clone).toHaveBeenCalledOnce()
  })

  it('starts a different clone when the person comes back and changes the address', async () => {
    const { clone } = await open()
    await fill()
    await click(button(en['clone.start']))
    await click(button(en.back))
    await type(field(en['clone.address']), 'https://github.com/acme/other.git')
    await click(button(en['clone.start']))
    expect(clone).toHaveBeenCalledTimes(2)
  })

  it('picks another place for the clone and returns with it', async () => {
    await open()
    await fill()
    await click(button(en['clone.change']))
    await click(button('~/src'))
    await click(button(en['folder.choosePlace']))
    expect(screen.getByText('Will be cloned to ~/src/site')).toBeTruthy()
    expect(field(en['clone.address']).value).toBe('https://github.com/acme/site.git')
  })
})

describe('the folder browser on a phone', () => {
  it('shows one column at a time: the folders, then the selected folder\'s preview with a way back', async () => {
    await mount({ listings: { [HOME]: listingOf(HOME, ['src']) } })
    await start(/^Folder on this computer/)
    const columns = document.querySelector('[data-view]') as HTMLElement
    expect(columns.dataset.view).toBe('list')
    await click(screen.getByRole('option', { name: 'src' }))
    expect(columns.dataset.view).toBe('preview')
    await click(button(en['folder.backToList']))
    expect(columns.dataset.view).toBe('list')
    await waitFor(() => { expect(screen.getByRole('option', { name: 'src' }).getAttribute('aria-selected')).toBe('true') })
  })
})
