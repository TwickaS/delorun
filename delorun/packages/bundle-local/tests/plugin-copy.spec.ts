/** The Add plugin dialog copy override targets upstream's plugin manager namespace and locale keys. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_COPY, PLUGIN_MANAGER_NS } from '../src/client/plugin-copy-text.ts'

describe('the Add plugin dialog copy', () => {
  it('names upstream\'s plugin manager namespace', () => {
    const dir = join(import.meta.dirname, '../../../../packages/client/ui-plugin-manager/src/client')
    const upstream = readFileSync(join(dir, 'index.ts'), 'utf8')
    expect(upstream).toContain(`export const NS = '${PLUGIN_MANAGER_NS}'`)
    const locales = readFileSync(join(dir, 'locales.ts'), 'utf8')
    for (const key of Object.keys(PLUGIN_COPY.en)) expect(locales).toContain(`${key}:`)
  })
})
