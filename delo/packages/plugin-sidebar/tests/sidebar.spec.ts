import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { apply, Config, DEFAULT_SIDEBAR_SETTINGS, MAX_WORKSPACE_ICONS } from '../src/index.ts'

describe('the host half', () => {
  it('defaults every setting, keeps each live-editable, and refuses an unknown choice, a width off the slider or an update notice interval out of range', () => {
    const config = Config({})
    expect(Object.fromEntries(Object.keys(DEFAULT_SIDEBAR_SETTINGS).map(key => [key, config[key as keyof typeof config].get()])))
      .toEqual(DEFAULT_SIDEBAR_SETTINGS)
    for (const field of Object.values(Config.dict ?? {})) expect(field.meta.volatile).toBe(true)
    for (const wrong of [
      { headerArt: 'stars' }, { artPalette: 'teal' }, { view: 'list' }, { workingShelf: 'yes' }, { artStrength: 'loud' }, { artStyle: 'flag' },
      { sort: 'name' }, { confirmUnpin: 1 }, { width: 200 }, { width: 500 }, { width: 257 }, { artSeed: 0 }, { artSeed: 2_147_483_648 },
      { workspaceIcons: ['folder'] }, { updateNoticeRefreshMinutes: 4 }, { updateNoticeRefreshMinutes: 1441 }, { updateNoticeRefreshMinutes: 7.5 },
    ]) {
      expect(Config['~standard'].validate(wrong)).toHaveProperty('issues')
    }
  })

  it('stores a malformed icon as it is, so one bad icon never keeps the row from loading', () => {
    const stored = { 'workspace-1': { kind: 'glyph', glyph: 'rocket' }, 'workspace-2': 'folder' }
    expect(Config({ workspaceIcons: stored }).workspaceIcons.get()).toEqual(stored)
  })

  it('loads with at most the bound of Workspace icons and refuses a stored value above it', () => {
    const icons = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`workspace-${String(index)}`, 'x']))
    expect(() => { apply(new Context(), Config({ workspaceIcons: icons(MAX_WORKSPACE_ICONS) })) }).not.toThrow()
    expect(() => { apply(new Context(), Config({ workspaceIcons: icons(MAX_WORKSPACE_ICONS + 1) })) }).toThrow(RangeError)
  })

  it('serializes to a schema the studio can rehydrate and validate a stored value with', () => {
    // The studio's settings form rebuilds the schema from its serialized form, without any callback, and validates the row's value.
    const rehydrated = new Schema(JSON.parse(JSON.stringify(Config)) as Schema)
    const stored = { ...DEFAULT_SIDEBAR_SETTINGS, artStyle: 'pill', headerArt: 'waves', workspaceIcons: { 'workspace-1': 'folder' } }
    expect(() => (rehydrated as (value: unknown) => unknown)(stored)).not.toThrow()
  })

  it('keeps its settings without a generated form while the settings service is present', async () => {
    const ctx = new Context()
    const configure = vi.fn(() => () => {})
    ctx.provide('settings', { configure } as never)
    const fiber = ctx.plugin({ apply, Config }, {})
    await fiber.await()
    expect(configure).toHaveBeenCalledWith({ auto: false }, expect.anything())
    await fiber.dispose()
  })
})
