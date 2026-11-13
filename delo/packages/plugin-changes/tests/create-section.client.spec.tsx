// @vitest-environment jsdom
/** The Create a plugin section against a stand-in harness: the form, the result, the turn-on request and the remote page. */
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FunctionComponent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, CREATE_SECTION_ID, CREATE_SECTION_ORDER, inject, NS } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import { ACTION_PATHS, STATE_PATH, WORKSPACES_PATH, type WorkspacesView } from '../src/wire.ts'

const WORKSPACES: WorkspacesView = {
  atComputer: true,
  workspaces: [{ id: 'w1', title: 'Home work', path: '/work/home' }, { id: 'w2', title: 'Side', path: '/work/side' }],
}

type Entry = {
  readonly options: { readonly name: string, readonly id?: string, readonly order?: number, readonly label?: () => string, readonly locale?: string, readonly inject?: () => object }
  readonly component: FunctionComponent<object>
}

/** A stand-in harness; `routes` replace the defaults per path. */
function harness(workspaces: WorkspacesView = WORKSPACES, routes: Record<string, (body: Record<string, unknown>) => Response> = {}) {
  const calls: Array<{ path: string, body: Record<string, unknown> }> = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = `/${String(input)}`
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path, body })
    if (routes[path] !== undefined) return routes[path](body)
    if (path === WORKSPACES_PATH) return Response.json(workspaces)
    if (path === STATE_PATH) return Response.json({ atComputer: workspaces.atComputer, profile: 'default', leftOut: [], folders: [], requests: [], recent: [], harness: [], problems: [] })
    if (path === ACTION_PATHS.create) return Response.json({ kind: 'created', plugin: body.name, pluginKind: body.kind, workspace: body.workspace, folder: `/work/home/plugins/${String(body.name)}`, files: ['package.json', 'index.js'] })
    if (path === ACTION_PATHS.request) return Response.json({ kind: 'requested', entry: { id: 'c1', kind: 'plugin-install', state: 'pending', summary: 'x', createdAt: new Date().toISOString(), undoable: false } })
    return Response.json({ kind: 'revealed', folder: '/work/home/plugins/x' })
  })
  vi.stubGlobal('fetch', fetch)
  return { calls: (path: string) => calls.filter(call => call.path === path).map(call => call.body) }
}

/** The page as far as the plugin uses it, with the section mounted. */
async function open() {
  const ctx = new Context()
  ctx.provide('locale', { bind: () => makeTranslate(en), register: () => () => {} })
  const entries = new Set<Entry>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => { register() },
    register: (options: Entry['options'], component: Entry['component']) => {
      const added = { options, component }
      entries.add(added)
      return () => { entries.delete(added) }
    },
  })
  await ctx.plugin({ inject: [...inject], apply }).await()
  const entry = [...entries].find(candidate => candidate.options.id === CREATE_SECTION_ID)!
  const face = (entry.options.inject?.() ?? {}) as Record<string, unknown>
  const Component = entry.component
  render(<Component {...{ t: makeTranslate(en), ...face }} />)
  return entry
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Create a plugin', () => {
  it('registers beside the Changes section with its own title', async () => {
    harness()
    const entry = await open()
    expect([entry.options.order, entry.options.label?.(), entry.options.locale]).toEqual([CREATE_SECTION_ORDER, en['create.nav'], NS])
    await screen.findByRole('heading', { name: en['create.title'] })
  })

  it('creates the plugin in the chosen workspace, shows where it goes and lists the files', async () => {
    const fake = harness()
    await open()
    await screen.findByLabelText(en['create.name'])
    expect(screen.getByText('Goes in /work/home/plugins')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en['create.workspace']), { target: { value: 'w2' } })
    expect(screen.getByText('Goes in /work/side/plugins')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en['create.name']), { target: { value: ' @me/hello ' } })
    fireEvent.change(screen.getByLabelText(en['create.kind']), { target: { value: 'preset' } })
    fireEvent.click(screen.getByRole('button', { name: en['create.submit'] }))
    await screen.findByText('package.json')
    expect(fake.calls(ACTION_PATHS.create)).toEqual([{ name: '@me/hello', kind: 'preset', workspace: 'w2' }])
    expect(screen.getByText(en['create.off'])).toBeTruthy()
  })

  it('asks for the plugin to be turned on, which waits in Changes, and opens the folder', async () => {
    const fake = harness()
    await open()
    fireEvent.change(await screen.findByLabelText(en['create.name']), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: en['create.submit'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['create.turnOn'] }))
    await screen.findByText(en['create.requested'])
    expect(fake.calls(ACTION_PATHS.request)).toEqual([{ name: 'hello', workspace: 'w1' }])
    expect((screen.getByRole('button', { name: en['create.turnOn'] }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en['create.open'] }))
    await waitFor(() => { expect(fake.calls(ACTION_PATHS.reveal)).toEqual([{ name: 'hello', workspace: 'w1' }]) })
    fireEvent.click(screen.getByRole('button', { name: en['create.another'] }))
    expect((await screen.findByLabelText(en['create.name']) as HTMLInputElement).value).toBe('')
  })

  it('shows a refusal beside the form and keeps what was typed', async () => {
    harness(WORKSPACES, { [ACTION_PATHS.create]: () => Response.json({ code: 'BAD_REQUEST', message: 'that name is taken' }, { status: 400 }) })
    await open()
    fireEvent.change(await screen.findByLabelText(en['create.name']), { target: { value: 'taken' } })
    fireEvent.click(screen.getByRole('button', { name: en['create.submit'] }))
    expect((await screen.findByRole('alert')).textContent).toBe('Nothing was created: that name is taken')
    expect((screen.getByLabelText(en['create.name']) as HTMLInputElement).value).toBe('taken')
  })

  it('says to do it at the computer on a page that is not, with no form', async () => {
    harness({ atComputer: false, workspaces: WORKSPACES.workspaces })
    await open()
    await screen.findByText(en['create.remote'])
    expect(screen.queryByLabelText(en['create.name'])).toBeNull()
  })

  it('asks for a workspace first when there is none, and offers a retry when the read fails', async () => {
    harness({ atComputer: true, workspaces: [] })
    await open()
    await screen.findByText(en['create.noWorkspace'])
    cleanup()
    vi.unstubAllGlobals()
    harness(WORKSPACES, { [WORKSPACES_PATH]: () => new Response('no', { status: 500 }) })
    await open()
    await screen.findByText(en['create.failed'])
    vi.unstubAllGlobals()
    harness()
    fireEvent.click(screen.getByRole('button', { name: en['create.retry'] }))
    await screen.findByLabelText(en['create.name'])
  })
})
