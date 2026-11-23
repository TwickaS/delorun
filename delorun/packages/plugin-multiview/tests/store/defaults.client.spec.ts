import { describe, expect, it } from 'vitest'
import { DEFAULT_MULTIVIEW_SETTINGS, type MultiviewSettings } from '../../src/config.ts'
import { buildPreset, panesOf, shapeOf, type LayoutModel } from '../../src/layout/index.ts'
import { planDefaults, planResetToAuto, resolveDefaults } from '../../src/store/scope.ts'
import { A, B, C, CHAT, makeStore, sid } from '../entry/fixtures.ts'

const OTHER = sid('other-chat')
const settings = (patch: Partial<MultiviewSettings> = {}): MultiviewSettings => ({ ...DEFAULT_MULTIVIEW_SETTINGS, ...patch })
const yoursShape = shapeOf(buildPreset('main-stack', CHAT, [A, B], { mainSide: 'right' }), [CHAT, A, B])
const gridShape = shapeOf(buildPreset('grid', CHAT, [A, B, C]), [CHAT, A, B, C])

/** A store connected to a Host writer that applies each patch to the settings, as the Settings service echoes it back. */
function connected(options: Parameters<typeof makeStore>[0] = {}, workspaces: Record<string, string> = {}) {
  const made = makeStore(options)
  const writes: Array<Partial<MultiviewSettings>> = []
  made.store.attachHost({
    write: async (patch) => { writes.push(patch); made.change(patch); return true },
    workspaceOf: chat => workspaces[chat],
  })
  return { ...made, writes }
}

/** A drag that rearranges the panes: the main chat moved to the right of a column of the others. */
const dragged = (): LayoutModel => buildPreset('main-stack', CHAT, [A, B], { mainSide: 'right' })

describe('where the layout defaults come from', () => {
  it('reads the studio defaults when the chat has no workspace or its workspace has none', () => {
    expect(resolveDefaults(settings({ defaultLayout: 'grid' }), undefined)).toMatchObject({ layout: 'grid', shape: undefined })
    expect(resolveDefaults(settings({ defaultLayout: 'grid' }), 'ws-1')).toMatchObject({ layout: 'grid' })
  })

  it('prefers the workspace over the studio, field by field', () => {
    const resolved = resolveDefaults(settings({
      defaultLayout: 'yours', yours: gridShape, mainSide: 'left',
      workspaceLayouts: { 'ws-1': { defaultLayout: 'yours', yours: yoursShape } },
    }), 'ws-1')
    expect(resolved).toMatchObject({ layout: 'yours', shape: yoursShape, shapeScope: 'workspace', mainSide: 'left' })
    expect(resolveDefaults(settings({ yours: gridShape, defaultLayout: 'yours' }), 'ws-2')).toMatchObject({ shape: gridShape, shapeScope: 'studio' })
  })

  it('reads yours without a saved arrangement as Auto, and ignores an arrangement that is not well formed', () => {
    expect(resolveDefaults(settings({ defaultLayout: 'yours' }), undefined).layout).toBe('auto')
    const broken = { version: 1 as const, root: { kind: 'leaf' as const, slots: [0, 0], active: 0, size: 100 } }
    expect(resolveDefaults(settings({ defaultLayout: 'yours', yours: broken }), undefined)).toMatchObject({ layout: 'auto', shape: undefined })
  })

  it('writes to the studio, the workspace or nowhere by scope, the workspace scope falling back to the studio', () => {
    expect(planDefaults(settings(), 'studio', 'ws-1', { defaultLayout: 'grid' })).toEqual({ defaultLayout: 'grid' })
    expect(planDefaults(settings(), 'workspace', 'ws-1', { defaultLayout: 'grid' })).toEqual({ workspaceLayouts: { 'ws-1': { defaultLayout: 'grid' } } })
    expect(planDefaults(settings(), 'workspace', undefined, { defaultLayout: 'grid' })).toEqual({ defaultLayout: 'grid' })
    expect(planDefaults(settings(), 'chat', 'ws-1', { defaultLayout: 'grid' })).toEqual({})
  })

  it('resets to Auto at the studio and in the chat’s workspace, keeping its other defaults', () => {
    const current = settings({ yours: gridShape, workspaceLayouts: { 'ws-1': { defaultLayout: 'yours', yours: yoursShape, mainSide: 'right' }, 'ws-2': { defaultLayout: 'tabs' } } })
    expect(planResetToAuto(current, 'ws-1')).toEqual({
      defaultLayout: 'auto', yours: null, workspaceLayouts: { 'ws-1': { mainSide: 'right' }, 'ws-2': { defaultLayout: 'tabs' } },
    })
  })
})

describe('the default for new Multiviews', () => {
  it('is Auto for a person who changed nothing', () => {
    const { store } = connected()
    store.pin(CHAT, A)
    expect(store.of(CHAT).getSnapshot().arrangement).toBe('auto')
  })

  it('becomes the layout chosen in the picker, for new chats; a chat already open keeps its own', () => {
    const { store, writes } = connected()
    store.pin(OTHER, A)
    store.pin(CHAT, A)
    store.chooseLayout(CHAT, 'spiral')
    expect(writes.at(-1)).toEqual({ defaultLayout: 'spiral' })
    expect(store.arrangementOf(CHAT)).toBe('spiral')
    expect(store.arrangementOf(OTHER)).toBe('auto')
    store.pin(sid('new-chat'), B)
    expect(store.arrangementOf(sid('new-chat'))).toBe('spiral')
  })

  it('reads a chat saved before layouts were remembered as its own arrangement, and an unarranged one as the default', () => {
    const layout = buildPreset('main-column', CHAT, [A])
    const { store } = connected({ initial: { [CHAT]: { pins: [A], layout, open: true }, [OTHER]: { pins: [B], layout: null, open: true } } })
    expect(store.arrangementOf(CHAT)).toBe('custom')
    expect(store.layoutFor(CHAT)).toEqual(layout)
    expect(store.arrangementOf(OTHER)).toBe('auto')
  })
})

describe('Yours', () => {
  it('keeps a dragged arrangement as a shape, applies it to other chats’ agents, and says where it was saved', async () => {
    const { store, change } = connected()
    store.pinAll(CHAT, [A, B])
    const result = store.adoptArrangement(CHAT, dragged(), 'move')
    expect(result).toMatchObject({ saved: true, scope: 'studio' })
    expect(result.saved && await result.written).toBe(true)
    const saved = store.settings.getSnapshot()
    expect(saved.defaultLayout).toBe('yours')
    expect(JSON.stringify(saved.yours)).not.toContain('agent-a')
    const x = sid('x'), y = sid('y')
    store.pinAll(OTHER, [x, y])
    expect(store.arrangementOf(OTHER)).toBe('yours')
    expect(panesOf(store.layoutFor(OTHER))).toEqual([x, y, OTHER])
    change({})
  })

  it('saves for this workspace only with the workspace scope, and for nobody else with the chat scope', async () => {
    const ws = connected({ settings: { rememberScope: 'workspace' } }, { [CHAT]: 'ws-1', [OTHER]: 'ws-2' })
    ws.store.pinAll(CHAT, [A, B])
    expect(ws.store.adoptArrangement(CHAT, dragged(), 'move')).toMatchObject({ saved: true, scope: 'workspace' })
    expect(ws.store.settings.getSnapshot().yours ?? null).toBeNull()
    expect(ws.store.defaultsOf(CHAT).shapeScope).toBe('workspace')
    expect(ws.store.defaultsOf(OTHER).shape).toBeUndefined()

    const one = connected({ settings: { rememberScope: 'chat' } })
    one.store.pinAll(CHAT, [A, B])
    const chatOnly = one.store.adoptArrangement(CHAT, dragged(), 'move')
    expect(chatOnly).toMatchObject({ saved: true, scope: 'chat' })
    expect(chatOnly.saved && await chatOnly.written).toBe(true)
    expect(one.writes).toEqual([])
    expect(one.store.arrangementOf(CHAT)).toBe('yours')
    one.store.pin(OTHER, A)
    expect(one.store.arrangementOf(OTHER)).toBe('auto')
  })

  it('with "moving panes only", keeps a resize with the chat and saves a move', () => {
    const { store, writes } = connected({ settings: { saveOn: 'move' } })
    store.pinAll(CHAT, [A, B])
    expect(store.adoptArrangement(CHAT, dragged(), 'resize')).toEqual({ saved: false })
    expect(writes).toEqual([])
    expect(store.arrangementOf(CHAT)).toBe('custom')
    expect(store.adoptArrangement(CHAT, dragged(), 'move')).toMatchObject({ saved: true, scope: 'studio' })
  })

  it('undoes: the previous default and the chat’s previous arrangement come back', () => {
    const { store } = connected({ settings: { defaultLayout: 'grid' } })
    store.pinAll(CHAT, [A, B])
    expect(store.arrangementOf(CHAT)).toBe('grid')
    store.adoptArrangement(CHAT, dragged(), 'move')
    expect(store.defaultsOf(CHAT).canUndo).toBe(true)
    store.undoDefault()
    expect(store.settings.getSnapshot()).toMatchObject({ defaultLayout: 'grid' })
    expect(store.settings.getSnapshot().yours ?? null).toBeNull()
    expect(store.arrangementOf(CHAT)).toBe('grid')
    expect(store.defaultsOf(CHAT).canUndo).toBe(false)
  })

  it('resets to Auto: Yours is cleared and the chat shows Auto', () => {
    const { store } = connected()
    store.pinAll(CHAT, [A, B])
    store.adoptArrangement(CHAT, dragged(), 'move')
    store.resetToAuto(CHAT)
    expect(store.settings.getSnapshot()).toMatchObject({ defaultLayout: 'auto', yours: null })
    expect(store.arrangementOf(CHAT)).toBe('auto')
    expect(store.of(CHAT).getSnapshot().shape).toBeUndefined()
  })

  it('a chat that follows its own copy keeps it when Yours changes elsewhere', () => {
    const { store } = connected()
    store.pinAll(CHAT, [A, B])
    store.adoptArrangement(CHAT, dragged(), 'move')
    store.pinAll(OTHER, [A, B])
    const before = store.of(OTHER).getSnapshot().shape
    store.adoptArrangement(CHAT, buildPreset('rows', CHAT, [A, B]), 'move')
    expect(store.of(OTHER).getSnapshot().shape).toEqual(before)
  })
})

describe('the layout keys’ store operations', () => {
  it('cycles the layout and makes it the default', () => {
    const { store } = connected()
    store.pin(CHAT, A)
    store.cycleLayout(CHAT, 1)
    expect(store.arrangementOf(CHAT)).toBe('main-stack')
    store.cycleLayout(CHAT, -1)
    store.cycleLayout(CHAT, -1)
    expect(store.arrangementOf(CHAT)).toBe('tabs')
  })

  it('swaps a pane into the main place, which the layout follows', () => {
    const { store } = connected({ settings: { defaultLayout: 'main-stack' } })
    store.pinAll(CHAT, [A, B])
    store.swapWithMain(CHAT, B)
    expect(store.of(CHAT).getSnapshot().slots).toEqual([B, A, CHAT])
    expect(panesOf(store.layoutFor(CHAT))[0]).toBe(B)
  })

  it('grows and shrinks the main share within its bounds', () => {
    const { store } = connected({ settings: { defaultLayout: 'main-stack', mainShare: 70 } })
    store.pin(CHAT, A)
    store.resizeMain(CHAT, 1)
    store.resizeMain(CHAT, 1)
    expect(store.defaultsOf(CHAT).mainShare).toBe(75)
    store.resizeMain(CHAT, -1)
    expect(store.defaultsOf(CHAT).mainShare).toBe(70)
  })
})

describe('a refused write of the defaults', () => {
  it('reports the refusal, takes the default back, and leaves nothing to undo; the chat keeps its arrangement', async () => {
    const made = makeStore({ settings: { defaultLayout: 'grid' } })
    made.store.attachHost({ write: async () => false })
    made.store.pinAll(CHAT, [A, B])
    const result = made.store.adoptArrangement(CHAT, dragged(), 'move')
    expect(made.store.defaultsOf(CHAT).layout).toBe('yours')
    expect(result.saved && await result.written).toBe(false)
    expect(made.store.defaultsOf(CHAT)).toMatchObject({ layout: 'grid', canUndo: false })
    expect(made.store.arrangementOf(CHAT)).toBe('yours')
    made.store.pin(OTHER, A)
    expect(made.store.arrangementOf(OTHER)).toBe('grid')
  })

  it('counts a failed request and a store with no Host as refusals', async () => {
    const failing = makeStore()
    failing.store.attachHost({ write: () => Promise.reject(new Error('offline')) })
    failing.store.pinAll(CHAT, [A, B])
    const failed = failing.store.adoptArrangement(CHAT, dragged(), 'move')
    expect(failed.saved && await failed.written).toBe(false)
    const alone = makeStore()
    alone.store.pinAll(CHAT, [A, B])
    const unwritten = alone.store.adoptArrangement(CHAT, dragged(), 'move')
    expect(unwritten.saved && await unwritten.written).toBe(false)
    expect(alone.store.defaultsOf(CHAT).layout).toBe('auto')
  })
})
