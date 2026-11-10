import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as host from '../src/index.ts'

const { Config } = host
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

/** The styles one page request collects from the host half. */
async function printedStyles(config: object): Promise<string[]> {
  const ctx = new Context()
  const fiber = ctx.plugin(host, config)
  await fiber.await()
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table, PAGE_PEER)
  await fiber.dispose()
  return table.flatMap(row => (row.kind === 'style' ? [row.text] : []))
}

describe('the host half', () => {
  it('defaults every setting, with the studio additions off, and rejects a custom accent that is not #RRGGBB', () => {
    const config = Config({})
    expect([config.accent.get(), config.customAccent.get(), config.typeface.get(), config.density.get(), config.studioAdditions.get()])
      .toEqual(['peach', '#E5734A', 'delo', 'comfortable', false])
    expect(Config['~standard'].validate({ density: 'tight' })).toHaveProperty('issues')
    expect(Config['~standard'].validate({ customAccent: 'peach' })).toHaveProperty('issues')
    expect(Config['~standard'].validate({ accent: 'teal' })).toHaveProperty('issues')
    expect(Config['~standard'].validate({ studioAdditions: 'yes' })).toHaveProperty('issues')
  })

  it('declares the studio additions switch as a live-editable boolean whose default is false', () => {
    const field = Config.dict?.studioAdditions
    expect(field?.type).toBe('boolean')
    expect(field?.meta.volatile).toBe(true)
    expect(field?.meta.default).toBe(false)
    expect(Object.keys(Config.dict ?? {})).not.toContain('classic')
  })

  it('prints the first-paint style into each page while the studio additions are on, and none while they are off', async () => {
    const [style] = await printedStyles({ studioAdditions: true })
    expect(style).toContain('--dsw-alias-brand-primary')
    expect(await printedStyles({ studioAdditions: true })).toHaveLength(1)
    expect(await printedStyles({ studioAdditions: false })).toHaveLength(0)
    expect(await printedStyles({})).toHaveLength(0)
  })

  it('prints the boot page\'s wordmark and the settings as globals only while the studio additions are on', async () => {
    const globals = async (config: object): Promise<IndexInjection[]> => {
      const ctx = new Context()
      const fiber = ctx.plugin(host, config)
      await fiber.await()
      const table: IndexInjection[] = []
      ctx.emit('webserver/index-inject', table, PAGE_PEER)
      await fiber.dispose()
      return table.filter(row => row.kind === 'global')
    }
    expect(host.BOOT_WORDMARK_GLOBAL).toBe('dshBootWordmark')
    expect(host.BOOT_SETTINGS_GLOBAL).toBe('deloThemeSettings')
    expect(await globals({ studioAdditions: true, palette: 'iris' })).toEqual([
      { kind: 'global', name: 'dshBootWordmark', value: 'Delo' },
      { kind: 'global', name: 'deloThemeSettings', value: host.currentSettings(Config({ studioAdditions: true, palette: 'iris' })) },
    ])
    expect(await globals({ studioAdditions: false })).toEqual([])
  })

  it('reads the switch live: a page requested after it flips prints the style, and one requested before does not', () => {
    let on = false
    const config = { ...Config({}), studioAdditions: { get: () => on } }
    const ctx = new Context()
    host.apply(ctx, config)
    const page = (): number => {
      const table: IndexInjection[] = []
      ctx.emit('webserver/index-inject', table, PAGE_PEER)
      return table.length
    }
    const before = page()
    on = true
    const during = page()
    on = false
    expect([before, during, page()]).toEqual([0, 3, 0])
    expect(host.currentSettings(config)).toMatchObject({ studioAdditions: false, palette: 'soft', contrast: 100, effort: 'label' })
  })

  it('serves its settings to the studio page itself, so the settings service builds no form for the row', async () => {
    const ctx = new Context()
    const configure = vi.fn((_presentation: { auto?: boolean }, _owner?: object) => () => {})
    ctx.provide('settings', { configure })
    const fiber = ctx.plugin(host, {})
    await fiber.await()
    expect(configure.mock.calls.map(call => call[0])).toEqual([{ auto: false }])
    await fiber.dispose()
  })
})
