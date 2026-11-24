// @vitest-environment jsdom
/** The studio plugins' switches: what the card reads from the Host, and the write that turns a row on. */
import { Context } from '@deepseek-ai/cordis'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStudioRows } from '../src/client/studio-rows-store.ts'
import { STUDIO_BUNDLE, STUDIO_ROWS } from '../src/client/studio-rows.ts'

afterEach(() => { vi.restoreAllMocks() })

/** One row as the Host's `listBundles` reports it. */
function row(rowId: string, entryId: string | undefined, title: string) {
  return { rowId, moduleName: `@delorun/plugin-${rowId}`, meta: { title }, ...entryId === undefined ? {} : { entryId } }
}

/** The Host's plugin manager, scripted: the bundle with its two rows, and the live entries behind them. */
function manager(options: { readonly readOnly?: string } = {}) {
  const setPluginEnabled = vi.fn(async (id: string, on: boolean) => ({
    ok: true as const,
    value: { changed: true, application: 'applied' as const, stage: 'enable' as const, target: id, enabled: on },
  }))
  return {
    setPluginEnabled,
    listBundles: vi.fn(async () => ({
      ok: true as const,
      value: [{
        name: STUDIO_BUNDLE, official: true, availability: 'profile' as const, installed: true, enabled: true, optional: false, removable: false,
        rows: [row('delorun-cost-meter', 'entry-cost', 'Cost meter'), row('delorun-thinking-rsvp', 'entry-thinking', 'Thinking tab')],
        overrides: [],
      }],
    })),
    listPlugins: vi.fn(async () => ({
      ok: true as const,
      value: [
        { entryId: 'entry-cost', moduleName: '@delorun/plugin-cost-meter', enabled: false, fiberPhase: 'active' as const },
        {
          entryId: 'entry-thinking', moduleName: '@delorun/plugin-thinking-rsvp', enabled: false, fiberPhase: 'active' as const,
          ...options.readOnly === undefined ? {} : { readOnlyReason: options.readOnly as 'unaddressable' },
        },
      ],
    })),
  }
}

/** A context carrying the scripted plugin manager, and the remote that delivers its events. */
function bench(options: Parameters<typeof manager>[0] = {}) {
  const ctx = new Context()
  const plugins = manager(options)
  const remote = new TestRemote(ctx, { pluginManager: plugins })
  const face = createStudioRows(ctx, text => typeof text === 'string' ? text : text.en)
  return { ctx, plugins, remote, face }
}

/** Wait for the store's first read to settle. */
async function settled(face: ReturnType<typeof createStudioRows>) {
  await vi.waitFor(() => { expect(face.hooks.rows.getSnapshot().rows.length).toBeGreaterThan(0) })
  return face.hooks.rows.getSnapshot()
}

describe('the studio plugins\' switches', () => {
  it('lists the bundle\'s two optional rows with their own titles and entry ids', async () => {
    const { face } = bench()
    const state = await settled(face)
    expect(state.rows.map(each => each.rowId)).toEqual([...STUDIO_ROWS])
    expect(state.rows[0]).toMatchObject({ title: 'Cost meter', entryId: 'entry-cost' })
    expect(state.rows[1]).toMatchObject({ title: 'Thinking tab', entryId: 'entry-thinking' })
  })

  it('writes through the plugin manager\'s setPluginEnabled, the call the bundle\'s page makes', async () => {
    const { face, plugins } = bench()
    await settled(face)
    face.setEnabled('delorun-cost-meter', true)
    await vi.waitFor(() => { expect(plugins.setPluginEnabled).toHaveBeenCalledExactlyOnceWith('entry-cost', true) })
    // The write settles and the read that follows clears the busy mark.
    await vi.waitFor(() => { expect(face.hooks.rows.getSnapshot().busy).toBeUndefined() })
    expect(face.hooks.rows.getSnapshot().failed).toBeUndefined()
  })

  it('says a write failed when the Host reports it did not apply', async () => {
    const { face, plugins } = bench()
    await settled(face)
    plugins.setPluginEnabled.mockResolvedValueOnce({ ok: true as const, value: { changed: false, application: 'failed' as const, stage: 'enable' as const, target: 'entry-cost' } })
    face.setEnabled('delorun-cost-meter', true)
    await vi.waitFor(() => { expect(face.hooks.rows.getSnapshot().failed).toBe('delorun-cost-meter') })
  })

  it('says a write failed when the call rejects', async () => {
    const { face, plugins } = bench()
    await settled(face)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    plugins.setPluginEnabled.mockRejectedValueOnce(new Error('transport'))
    face.setEnabled('delorun-cost-meter', true)
    await vi.waitFor(() => { expect(face.hooks.rows.getSnapshot().failed).toBe('delorun-cost-meter') })
  })

  it('locks a row the Host refuses to address', async () => {
    const { face } = bench({ readOnly: 'unaddressable' })
    const state = await settled(face)
    expect(state.rows.find(each => each.rowId === 'delorun-thinking-rsvp')?.readOnlyReason).toBe('unaddressable')
  })

  it('reads again when the Host announces a change to the profile', async () => {
    const { face, plugins, remote } = bench()
    await settled(face)
    plugins.listBundles.mockClear()
    remote.emit('plugin-manager/changed', [{ reason: 'bundle' }])
    await vi.waitFor(() => { expect(plugins.listBundles).toHaveBeenCalled() })
  })

  it('lists nothing when the profile has no plugin manager', async () => {
    const ctx = new Context()
    const face = createStudioRows(ctx, text => typeof text === 'string' ? text : text.en)
    await vi.waitFor(() => { expect(face.hooks.rows.getSnapshot().rows).toEqual([]) })
  })
})
