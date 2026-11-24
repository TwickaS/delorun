// @vitest-environment jsdom
/** The on-demand bundles' rows: the tag the rules hide, the wording they state, and the row that keeps its tag. */
import { afterEach, describe, expect, it } from 'vitest'
import { ON_DEMAND_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { PLUGIN_ID, ThemeController } from '../src/client/controller.ts'
import { followOnDemandLabel, ON_DEMAND_LABEL } from '../src/client/on-demand-label.ts'
import { NOT_INSTALLED_TAG, onDemandRowSelectors, onDemandRowsCss, PROBLEM_TAG, TITLE_ROW } from '../src/client/on-demand-rows.ts'
import { STUDIO_ON } from './theme-form.client.ts'

afterEach(() => {
  document.head.replaceChildren()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('style')
})

/** One card as the page draws it: the title line with its tags, and the row's package name. */
function card(name: string, tags: readonly string[]): string {
  return `<li data-plugin-package="${name}"><div class="GoCB5G_cardHead"><div class="GoCB5G_cardMain">`
    + `<div class="GoCB5G_titleRow"><button class="GoCB5G_cardTitle">${name}</button>${tags.join('')}</div>`
    + '</div></div></li>'
}

/** The page's own tags: the red problem tag and the quiet not-installed tag. */
const PROBLEM = `<span class="GoCB5G_statusTag" data-tone="danger">Problem</span>`
const NOT_INSTALLED = `<span class="GoCB5G_statusTag" data-tone="outline">Not installed</span>`

describe('the on-demand bundles\' rows', () => {
  it('reach every on-demand bundle the release lists, on its row and on its page', () => {
    const selectors = onDemandRowSelectors()
    expect(selectors).toHaveLength(ON_DEMAND_BUNDLES.length * 2)
    for (const name of ON_DEMAND_BUNDLES) {
      expect(selectors).toContain(`[data-plugin-package="${name}"]`)
      expect(selectors).toContain(`[data-plugin-detail="${name}"]`)
    }
  })

  it('hide the red tag of a row the profile does not hold, and only there', () => {
    const css = onDemandRowsCss()
    for (const name of ON_DEMAND_BUNDLES) {
      expect(css).toContain(`[data-plugin-package="${name}"]:has(${NOT_INSTALLED_TAG}) ${PROBLEM_TAG}`)
    }
    // The rule names the not-installed tag as its condition, so an installed bundle that is genuinely broken keeps its tag.
    expect(css).not.toMatch(/:has\(\)/)
    expect(PROBLEM_TAG).toContain('[data-tone="danger"]')
  })

  it('state what the row is, in the words the theme layer sets', () => {
    const css = onDemandRowsCss()
    expect(css).toContain(`content:var(${ON_DEMAND_LABEL})`)
    for (const name of ON_DEMAND_BUNDLES) expect(css).toContain(`[data-plugin-package="${name}"] ${TITLE_ROW}::after`)
  })

  it('reach the row the page draws and leave a bundle that is not on demand alone', () => {
    document.body.innerHTML = card(ON_DEMAND_BUNDLES[0] as string, [PROBLEM, NOT_INSTALLED])
      + card('@deepseek-ai/dsh-experimental-voice-input-bundle', [PROBLEM, NOT_INSTALLED])
    const reached = [...document.querySelectorAll(onDemandRowSelectors().join(','))]
    expect(reached).toHaveLength(1)
    expect(reached[0]?.getAttribute('data-plugin-package')).toBe(ON_DEMAND_BUNDLES[0])
    // The condition the rule hides under holds on the reached row.
    expect(reached[0]?.querySelector(NOT_INSTALLED_TAG)).not.toBeNull()
    expect(reached[0]?.querySelector(PROBLEM_TAG)).not.toBeNull()
  })

  it('set the wording as a quoted custom property, and follow a change of language', () => {
    let language = 'en'
    const listeners: (() => void)[] = []
    const stop = followOnDemandLabel(document, () => language === 'en' ? 'Installs on demand' : '按需安装', (listener) => {
      listeners.push(listener)
      return () => { listeners.splice(listeners.indexOf(listener), 1) }
    })
    expect(document.documentElement.style.getPropertyValue(ON_DEMAND_LABEL)).toBe('"Installs on demand"')
    language = 'zh'
    for (const listener of [...listeners]) listener()
    expect(document.documentElement.style.getPropertyValue(ON_DEMAND_LABEL)).toBe('"按需安装"')
    stop()
    expect(document.documentElement.style.getPropertyValue(ON_DEMAND_LABEL)).toBe('')
  })

  it('applies only with the Delorun look: the stock look keeps upstream\'s tag', () => {
    const theme = { overrideTokens: () => () => {} }
    const controller = new ThemeController(theme, onDemandRowsCss(), document)
    controller.update(STUDIO_ON)
    expect(document.head.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)?.textContent).toContain(PROBLEM_TAG)
    controller.update(DEFAULT_SETTINGS)
    expect(document.head.querySelector('style')).toBeNull()
    controller.dispose()
  })
})
