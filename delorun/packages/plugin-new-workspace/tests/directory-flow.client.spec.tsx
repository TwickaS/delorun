// @vitest-environment jsdom
/**
 * The ways in: the Delorun occupant of upstream's three directory-flow holes, which opens the new-workspace dialog when a
 * hole's owner asks for a folder and hands the workspace's folder back, and its registration under the Delorun look only.
 */
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DelorunDirectoryFlow, type DirectoryFlowSource } from '../src/client/DirectoryFlow.tsx'
import { apply, DIRECTORY_FLOW_HOLES, DIRECTORY_FLOW_PRIORITY, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const settle = async () => { await act(async () => { for (let n = 0; n < 6; n++) await Promise.resolve() }) }

/** A dialog the spec ends by hand, and the owner's callbacks. */
function owner() {
  let finish: (path: string | undefined) => void = () => {}
  const openFlow = vi.fn((_from: DirectoryFlowSource) => new Promise<string | undefined>((resolve) => { finish = resolve }))
  const onPicked = vi.fn()
  const onCancel = vi.fn()
  const draw = (open: boolean) => <DelorunDirectoryFlow open={open} busy={false} onPicked={onPicked} onCancel={onCancel} onError={vi.fn()} from="sidebar" openFlow={openFlow} />
  return { openFlow, onPicked, onCancel, draw, finish: (path: string | undefined) => { finish(path) } }
}

describe('the directory-flow occupant', () => {
  it('opens the dialog once when the owner asks, and hands back the folder of the workspace it made', async () => {
    const flow = owner()
    const view = render(flow.draw(false))
    expect(flow.openFlow).not.toHaveBeenCalled()
    view.rerender(flow.draw(true))
    view.rerender(flow.draw(true))
    expect(flow.openFlow.mock.calls).toEqual([['sidebar']])
    flow.finish('/home/person/src/site')
    await settle()
    expect([flow.onPicked.mock.calls, flow.onCancel.mock.calls.length]).toEqual([[['/home/person/src/site']], 0])
    expect(view.container.innerHTML).toBe('')
  })

  it('reports a closed dialog as cancelled', async () => {
    const flow = owner()
    render(flow.draw(true))
    flow.finish(undefined)
    await settle()
    expect([flow.onPicked.mock.calls.length, flow.onCancel.mock.calls.length]).toEqual([0, 1])
  })

  it('reports nothing for a request the owner withdrew before the dialog ended', async () => {
    const flow = owner()
    const view = render(flow.draw(true))
    view.rerender(flow.draw(false))
    flow.finish('/home/person/src/site')
    await settle()
    expect([flow.onPicked.mock.calls.length, flow.onCancel.mock.calls.length]).toEqual([0, 0])
  })
})

describe('the ways in', () => {
  /** The page as far as the registrations use it. */
  async function harness(studio: boolean) {
    const ctx = new Context()
    ctx.provide('locale', { bind: () => makeTranslate(en), register: () => () => {} })
    const registered = new Map<string, { readonly priority?: number, readonly inject?: () => unknown }>()
    ctx.provide('slots', {
      inject: (_: string, register: () => () => void) => register(),
      register: (options: { readonly name: string, readonly id?: string, readonly priority?: number, readonly inject?: () => unknown }) => {
        const key = `${options.name}#${options.id ?? ''}`
        registered.set(key, options)
        return () => { registered.delete(key) }
      },
    })
    if (studio) ctx.provide('delorunStudio', {})
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    return { ctx, registered }
  }

  it('occupies the sidebar, new-chat picker and hero holes below upstream\'s pickers under the Delorun look', async () => {
    const { registered } = await harness(true)
    for (const [hole, from] of DIRECTORY_FLOW_HOLES) {
      const entry = registered.get(`${hole}#`)
      expect(entry?.priority).toBe(DIRECTORY_FLOW_PRIORITY)
      expect(entry?.inject?.()).toMatchObject({ from })
    }
    expect(DIRECTORY_FLOW_PRIORITY).toBeLessThan(0)
  })

  it('leaves every hole to upstream under the stock look', async () => {
    const { registered } = await harness(false)
    for (const [hole] of DIRECTORY_FLOW_HOLES) expect(registered.has(`${hole}#`)).toBe(false)
  })

  it('opens the dialog from a hole and hands back the made workspace\'s folder', async () => {
    const { ctx, registered } = await harness(true)
    const service = ctx.get('delorunNewWorkspace')
    const open = vi.spyOn(service!, 'open').mockResolvedValue({ kind: 'created', workspaceId: 'workspace-1', path: '/home/person/src/site', folder: 'code' })
    const injected = registered.get('workspace.picker.directoryFlow#')?.inject?.() as { openFlow: (from: DirectoryFlowSource) => Promise<string | undefined> }
    expect(await injected.openFlow('picker')).toBe('/home/person/src/site')
    expect(open).toHaveBeenCalledWith({ from: 'picker' })
    open.mockResolvedValue({ kind: 'cancelled' })
    expect(await injected.openFlow('picker')).toBeUndefined()
  })
})
