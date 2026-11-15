// @vitest-environment jsdom
/** The Add plugin dialog names Delorun, not DeepSeek Harness, in English and Chinese, only while the override is held. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { afterEach, describe, expect, it } from 'vitest'
import { overridePluginCopy, PLUGIN_COPY, PLUGIN_MANAGER_NS } from '../src/client/plugin-copy.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

describe('the Add plugin dialog copy', () => {
  it('says Delorun instead of DeepSeek Harness and DSH, and gives upstream\'s text back once released', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const locale = new LocaleRuntime(ctx)
    locale.register(PLUGIN_MANAGER_NS, 'en', { installGuideSafety: 'can damage DeepSeek Harness', installUpgradeNotice: 'differs from DSH' })
    const read = (key: 'installGuideSafety' | 'installUpgradeNotice'): string => locale.bind(PLUGIN_MANAGER_NS)(key)
    const release = overridePluginCopy(locale)
    locale.setLocale('en')
    expect(read('installGuideSafety')).toBe(PLUGIN_COPY.en.installGuideSafety)
    expect(`${read('installGuideSafety')} ${read('installUpgradeNotice')}`).not.toMatch(/DeepSeek Harness|DSH/)
    release()
    expect(read('installUpgradeNotice')).toBe('differs from DSH')
  })
})
