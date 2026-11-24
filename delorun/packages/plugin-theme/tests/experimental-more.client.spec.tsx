// @vitest-environment jsdom
/** The Experimental plugins group's More control: the shape it takes, the count it states, and the page that states none. */
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { PLUGIN_ID, ThemeController } from '../src/client/controller.ts'
import { EXPERIMENTAL_GROUP, experimentalMoreCss, MORE_CONTROL, MORE_COUNT_ATTRIBUTE } from '../src/client/experimental-more.ts'
import { STUDIO_ON } from './theme-form.client.ts'

afterEach(() => {
  document.head.replaceChildren()
  document.body.replaceChildren()
})

/** Upstream's group head: the heading and the More control, with the count the page states. */
function groupMarkup(count?: number): void {
  document.body.innerHTML = `<section data-plugin-group="extensions"><div class="GoCB5G_groupHead">`
    + '<h3 class="GoCB5G_groupTitle">Experimental plugins</h3>'
    + `<button class="GoCB5G_button GoCB5G_sm GoCB5G_groupMore"${count === undefined ? '' : ` ${MORE_COUNT_ATTRIBUTE}="${String(count)}"`}>More<svg data-icon="dsw-icon-chevron-right-outline-regular"></svg></button>`
    + '</div></section>'
}

describe('the Experimental plugins group\'s More control', () => {
  it('reaches the group\'s control and no other button on the page', () => {
    groupMarkup(11)
    document.body.insertAdjacentHTML('beforeend', '<button class="GoCB5G_groupMore">Elsewhere</button>')
    const reached = [...document.querySelectorAll(`${EXPERIMENTAL_GROUP} ${MORE_CONTROL}`)]
    expect(reached).toHaveLength(1)
    expect(reached[0]?.closest('[data-plugin-group="extensions"]')).not.toBeNull()
  })

  it('gives the control the secondary button\'s shape rather than a text link\'s', () => {
    const css = experimentalMoreCss()
    expect(css).toContain('box-shadow:inset 0 0 0 var(--dsh-hairline-width,0.5px) var(--dsw-alias-border-l3)')
    expect(css).toContain('border-radius:var(--dsw-radius-sm)')
    // Upstream's negative margin aligns a text link with the cards; a control keeps its own edge.
    expect(css).toContain('margin-inline-end:0')
    expect(css).toContain('background:var(--dsw-alias-interactive-bg-hover)')
  })

  it('states the count from the page\'s own attribute, and only where the page states one', () => {
    const css = experimentalMoreCss()
    expect(css).toContain(`${EXPERIMENTAL_GROUP} ${MORE_CONTROL}[${MORE_COUNT_ATTRIBUTE}]::after`)
    expect(css).toContain(`content:" · " attr(${MORE_COUNT_ATTRIBUTE})`)
    // The count rule is scoped to the attribute, so a page without one matches no count rule and shows no separator.
    expect(css).not.toMatch(/\.groupMore[^{]*::after\{[^}]*content:" · "/)
  })

  it('puts the count before the chevron, so it reads as part of the words', () => {
    expect(experimentalMoreCss()).toContain(`${EXPERIMENTAL_GROUP} ${MORE_CONTROL}>svg{order:1}`)
  })

  it('states the count once: the button\'s own text is the label, and the count comes only from the pseudo-element', () => {
    groupMarkup(11)
    const control = document.querySelector(`${EXPERIMENTAL_GROUP} ${MORE_CONTROL}`)
    // The accessible name is the button's text plus its generated content, so the count is announced once and the
    // attribute, which is never announced, is left to the stylesheet.
    expect(control?.textContent).toBe('More')
    expect(control?.getAttribute(MORE_COUNT_ATTRIBUTE)).toBe('11')
    expect(experimentalMoreCss().match(/attr\(data-plugin-more-count\)/g)).toHaveLength(1)
  })

  it('applies only with the Delorun look: the stock look keeps upstream\'s text link', () => {
    const theme = { overrideTokens: () => () => {} }
    const controller = new ThemeController(theme, experimentalMoreCss(), document)
    controller.update(STUDIO_ON)
    expect(document.head.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)?.textContent).toContain(MORE_COUNT_ATTRIBUTE)
    controller.update(DEFAULT_SETTINGS)
    expect(document.head.querySelector('style')).toBeNull()
    controller.dispose()
  })
})
