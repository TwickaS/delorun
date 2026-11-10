import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, DEFAULT_SIDEBAR_SETTINGS } from '../src/index.ts'

describe('the host half', () => {
  it('defaults every setting, keeps each live-editable, and refuses an unknown choice or a width off the slider', () => {
    const config = Config({})
    expect(Object.fromEntries(Object.keys(DEFAULT_SIDEBAR_SETTINGS).map(key => [key, config[key as keyof typeof config].get()])))
      .toEqual(DEFAULT_SIDEBAR_SETTINGS)
    for (const field of Object.values(Config.dict ?? {})) expect(field.meta.volatile).toBe(true)
    for (const wrong of [
      { headerArt: 'stars' }, { artPalette: 'teal' }, { view: 'list' }, { workingShelf: 'yes' }, { artStrength: 'loud' }, { artStyle: 'flag' },
      { sort: 'name' }, { confirmUnpin: 1 }, { width: 200 }, { width: 500 }, { width: 257 }, { artSeed: 0 }, { artSeed: 2_147_483_648 },
      { workspaceIcons: ['folder'] },
    ]) {
      expect(Config['~standard'].validate(wrong)).toHaveProperty('issues')
    }
  })

  it('stores a malformed icon as it is, so one bad icon never keeps the row from loading', () => {
    const stored = { 'workspace-1': { kind: 'glyph', glyph: 'rocket' }, 'workspace-2': 'folder' }
    expect(Config({ workspaceIcons: stored }).workspaceIcons.get()).toEqual(stored)
  })

  it('keeps its settings without a generated form while the settings service is present', async () => {
    const ctx = new Context()
    const configure = vi.fn(() => () => {})
    ctx.provide('settings', { configure } as never)
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(configure).toHaveBeenCalledWith({ auto: false }, expect.anything())
    await fiber.dispose()
  })
})
