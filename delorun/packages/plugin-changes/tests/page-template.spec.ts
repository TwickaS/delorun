/** Changes and Create a plugin take the Settings page template: section headings and leads read the panel's shared properties. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/ChangesSection.module.css', import.meta.url), 'utf8')

it('draws Create a plugin with the section heading, not the page title', () => {
  const rule = /\.createHeading\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  expect(rule).toContain('--dsh-settings-card-heading-size, 15px')
  expect(rule).toContain('--dsh-settings-card-heading-weight, 500')
})

it('draws each group heading and the lead from the shared properties', () => {
  expect(/\.groupHeading\s*\{([^}]*)\}/.exec(css)?.[1]).toContain('--dsh-settings-card-heading-size, 15px')
  expect(/\.lead\s*\{([^}]*)\}/.exec(css)?.[1]).toContain('--dsh-settings-lead-size, 13px')
})

it('leaves no empty header row under a page title the shell draws', () => {
  expect(/\.header\s*\{([^}]*)\}/.exec(css)?.[1]).toContain('display: var(--dsh-settings-section-title-display, flex)')
})
