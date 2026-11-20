/**
 * The default install does not carry Browser: the Browser plugin is a signed pack that a home adds on first use, so the
 * release closure holds no Playwright package and no default bundle depends on the pack. Each denial test's comment
 * names the change that makes it fail.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const manifest = (path: string): { dependencies?: Record<string, string>; delorun?: { pack?: boolean } } => JSON.parse(read(path)) as never

describe('the release closure and Browser', () => {
  // Adding `@playwright/mcp` or `playwright-core` to the closure would ship the browser driver to every home.
  it('names no Playwright package', () => {
    expect(read('../../closure.json').toLowerCase()).not.toContain('playwright')
  })

  // Without `pack: true` the release would stop publishing Browser as a pack and carry it in the default install.
  it('keeps Browser a pack, not part of the default install', () => {
    expect(manifest('../../../../packages/bundle-browser/package.json').delorun?.pack).toBe(true)
  })

  // A default bundle that depends on the pack would pull its Playwright packages into the closure.
  it.each(['bundle-local', 'bundle-studio'])('does not make %s depend on the Browser pack or a Playwright package', (name) => {
    const dependencies = Object.keys(manifest(`../../../../packages/${name}/package.json`).dependencies ?? {})
    expect(dependencies.filter(each => each === '@delorun/bundle-browser' || /playwright/iu.test(each))).toEqual([])
  })
})
