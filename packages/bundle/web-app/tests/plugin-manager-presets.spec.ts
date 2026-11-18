/** The plugin_manager tool rows the shipped agent presets mount, and the switches each sets. */

import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

/** The tool-plugin-manager row of one shipped agent preset. */
function managerRow(preset: string): { disabled?: unknown; config?: Record<string, unknown> } | undefined {
  const [row] = loadOverlayPatches(preset, fileURLToPath(new URL(`../presets/${preset}.patch.yml`, import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
  const plugins = (row!.config as { plugins: { id: string; disabled?: unknown; config?: Record<string, unknown> }[] }).plugins
  return plugins.find(plugin => plugin.id === 'tool-plugin-manager')
}

it('turns on only the read exemption in the Standard and Creator presets, so every change still escalates', () => {
  for (const preset of ['standard', 'cordis']) expect(managerRow(preset)?.config, preset).toEqual({ readActionsExempt: true })
})

it('keeps the plugin_manager row disabled and unswitched in the PTC preset', () => {
  expect(managerRow('ptc')).toMatchObject({ disabled: true })
  expect(managerRow('ptc')?.config).toBeUndefined()
})
