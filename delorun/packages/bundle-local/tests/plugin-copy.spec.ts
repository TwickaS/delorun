/** The Add plugin dialog copy override targets upstream's plugin manager namespace and locale keys. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_COPY, PLUGIN_MANAGER_NS } from '../src/client/plugin-copy-text.ts'
import { SETTINGS_COPY } from '../src/client/settings-copy-text.ts'

describe('the Add plugin dialog copy', () => {
  it('names upstream\'s plugin manager namespace', () => {
    const dir = join(import.meta.dirname, '../../../../packages/client/ui-plugin-manager/src/client')
    const upstream = readFileSync(join(dir, 'index.ts'), 'utf8')
    expect(upstream).toContain(`export const NS = '${PLUGIN_MANAGER_NS}'`)
    const locales = readFileSync(join(dir, 'locales.ts'), 'utf8')
    for (const key of Object.keys(PLUGIN_COPY.en)) expect(locales).toContain(`${key}:`)
  })
})

describe('the settings pages copy', () => {
  const UPSTREAM: Record<string, { file: string; ns: string | undefined }> = {
    'settings.agentPreset': { file: 'ui-agent-preset/src/client/locales.ts', ns: undefined },
    'settings.plugins': { file: 'ui-settings-plugins/src/client/locales.ts', ns: undefined },
    'chat': { file: 'ui-chat/src/client/locale.ts', ns: undefined },
    'conversation': { file: 'ui-conversation/src/client/locales.ts', ns: undefined },
    'settings.permission': { file: 'ui-permission-presets/src/client/locales.ts', ns: undefined },
    'permission.access': { file: 'ui-permission-presets/src/client/locales.ts', ns: undefined },
  }

  it('overrides only keys that upstream\'s English dictionary defines', () => {
    const root = join(import.meta.dirname, '../../../../packages/client')
    for (const layer of SETTINGS_COPY) {
      const upstream = UPSTREAM[layer.ns]
      expect(upstream, layer.ns).toBeDefined()
      const source = readFileSync(join(root, upstream!.file), 'utf8')
      for (const key of Object.keys(layer.en)) expect(source, `${layer.ns} ${key}`).toMatch(new RegExp(`['"]?${key.replaceAll('.', '\\.')}['"]?:`))
    }
  })

  it('says chats, never sessions, and keeps developer words out', () => {
    for (const layer of SETTINGS_COPY) {
      for (const text of Object.values(layer.en)) expect(text).not.toMatch(/session|\bDSH\b|ctx\.|seam|behavior|customize/i)
    }
  })
})
