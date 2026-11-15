import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The composer text the studio keeps readable: the placeholder and the effort label. */
const TEXT = [
  ['../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.module.css', /^\.placeholder \{[^}]*\}/m],
  ['../../../../packages/client/ui-model-selection/src/client/ModelSelect.module.css', /^\.triggerEffort \{[^}]*\}/m],
] as const

describe('composer text contrast', () => {
  for (const [path, rule] of TEXT) {
    it(`${rule.source.slice(0, 16)} uses the secondary label colour, which is at least 4.5:1 in every theme`, () => {
      const css = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
      const block = rule.exec(css)?.[0] ?? ''
      expect(block).toContain('color: var(--dsw-alias-label-secondary)')
      expect(block).not.toContain('label-caption')
    })
  }
})
