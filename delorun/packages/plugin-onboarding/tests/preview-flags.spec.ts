/**
 * Onboarding's preview flags: what the Host half declares, and that the package's own manifest lists the same ids,
 * which is what `delorun preview` and the preview-flags row read.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertFlagsIndexed, createPreviewFlags } from '@delorun/preview-flags'
import { apply, Config, inject, name, PREVIEW_FLAGS, PREVIEW_STEPS } from '../src/index.ts'

describe('onboarding\'s preview flags', () => {
  it('are listed in the package\'s own manifest, id for id', () => {
    // Pins the index: a flag declared and not listed is refused by the Host, and one listed and not declared can be turned on and does nothing.
    const manifest: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    expect(() => { assertFlagsIndexed(manifest, PREVIEW_FLAGS.map(flag => flag.id)) }).not.toThrow()
  })

  it('name the plugin as their owner and have words in both languages', () => {
    expect(PREVIEW_STEPS.id).toBe('onboarding.previewSteps')
    for (const flag of PREVIEW_FLAGS) {
      expect(flag.owner).toBe('@delorun/plugin-onboarding')
      for (const text of [flag.title.en, flag.title.zh, flag.description.en, flag.description.zh]) expect(text.trim()).not.toBe('')
    }
  })

  it('are declared while the preview-flags row is mounted, and withdrawn with the plugin', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const { flags } = createPreviewFlags({ configured: {}, index: undefined, pluginOff: () => false })
    const fiber = ctx.plugin({ name, inject: [...inject], Config, apply })
    await fiber.await()
    // Without the row nothing is declared, and the plugin runs as before.
    expect(flags.list()).toEqual([])
    const withdraw = ctx.provide('previewFlags', flags)
    await fiber.await()
    await vi.waitFor(() => { expect(flags.list().map(flag => flag.id)).toEqual(['onboarding.previewSteps']) })
    expect(flags.isOn(PREVIEW_STEPS.id)).toBe(false)
    withdraw()
    await vi.waitFor(() => { expect(flags.list()).toEqual([]) })
  })
})
