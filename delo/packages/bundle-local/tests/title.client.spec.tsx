// @vitest-environment jsdom
/** The product name replaces upstream's local-build title text in every language, and only while the override is held. */
import { Context } from '@deepseek-ai/cordis'
import { COMMON_NS, LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { afterEach, describe, expect, it } from 'vitest'
import { PRODUCT_NAME } from '../src/client/brand.tsx'
import { overrideTitle, TITLE_KEY, TITLE_NS } from '../src/client/title.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A locale service holding upstream's English, Chinese and Japanese title texts. */
function localeService() {
  const ctx = new Context()
  contexts.push(ctx)
  const locale = new LocaleRuntime(ctx)
  locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })
  locale.register(COMMON_NS, 'en', { [TITLE_KEY]: 'DSH Local Build' })
  locale.register(COMMON_NS, 'zh', { [TITLE_KEY]: 'DSH 本地构建' })
  locale.register(COMMON_NS, 'ja', { [TITLE_KEY]: 'DSHローカルビルド' })
  const title = (id: string): string => {
    locale.setLocale(id)
    return locale.bind(COMMON_NS)(TITLE_KEY)
  }
  return { locale, title }
}

describe('the document title', () => {
  it('names upstream\'s common dictionary namespace', () => {
    expect(TITLE_NS).toBe(COMMON_NS)
  })

  it('reads the product name in every listed language, and upstream\'s text again once released', () => {
    const { locale, title } = localeService()
    const release = overrideTitle(locale)
    expect(PRODUCT_NAME).toBe('Delo')
    expect(['en', 'zh', 'ja'].map(title)).toEqual([PRODUCT_NAME, PRODUCT_NAME, PRODUCT_NAME])
    release()
    expect(['en', 'zh', 'ja'].map(title)).toEqual(['DSH Local Build', 'DSH 本地构建', 'DSHローカルビルド'])
  })

  it('covers a language added after the override, and stops following the list once released', () => {
    const { locale, title } = localeService()
    const release = overrideTitle(locale)
    locale.addLanguage({ id: 'de', label: 'Deutsch', fallback: 'en' })
    locale.register(COMMON_NS, 'de', { [TITLE_KEY]: 'Lokaler DSH-Build' })
    expect(title('de')).toBe(PRODUCT_NAME)
    release()
    expect(title('de')).toBe('Lokaler DSH-Build')
    locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
    locale.register(COMMON_NS, 'fr', { [TITLE_KEY]: 'Version locale de DSH' })
    expect(title('fr')).toBe('Version locale de DSH')
  })
})
