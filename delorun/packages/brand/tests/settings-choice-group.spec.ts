/** A filling choice group wraps a long label inside its segment. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('a filling choice group', () => {
  it('wraps a long label inside its segment instead of onto a second row', () => {
    const css = readFileSync(`${import.meta.dirname}/../src/settings/ChoiceGroup.module.css`, 'utf8')
    const rule = /\.group\[data-fill='true'\] \.segment\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toContain('white-space: normal')
    expect(rule).toContain('height: auto')
  })
})
