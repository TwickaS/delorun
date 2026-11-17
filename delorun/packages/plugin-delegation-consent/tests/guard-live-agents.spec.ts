/**
 * Denial specs of the plugin_manager guard for Delorun's live-agent packages: the model cannot install, enable or
 * reconfigure the start gate, either driver or the seat plugin, however the target spells it; disabling stays allowed
 * and fails closed through the gate.
 */
import { describe, expect, it } from 'vitest'
import { DELORUN_EXTERNAL_AGENT_PACKAGES, isExternalAgentPackage, PLUGIN_MANAGER_REFUSAL, pluginManagerVerdict } from '../src/guard.ts'

const rows = () => [
  { id: 'g1', rowId: 'external-agents', name: '@delorun/external-agents' },
  { id: 'g2', rowId: 'agent-claude-code', name: '@delorun/agent-claude-code' },
  { id: 'g3', rowId: 'agent-codex', name: '@Delorun/Agent-Codex/plugin' },
  { id: 'g4', rowId: 'agent-seats', name: '@delorun/plugin-agent-seats' },
  { id: 'g5', rowId: 'delegation-consent', name: '@delorun/plugin-delegation-consent' },
]
const call = (args: object) => pluginManagerVerdict({ name: 'plugin_manager', arguments: args }, rows, () => undefined)

describe('the plugin_manager guard over Delorun\'s live-agent packages', () => {
  it('names exactly the gate, both drivers and the seat plugin', () => {
    expect([...DELORUN_EXTERNAL_AGENT_PACKAGES].sort()).toEqual([
      '@delorun/agent-claude-code', '@delorun/agent-codex', '@delorun/external-agents', '@delorun/plugin-agent-seats',
    ])
    expect(isExternalAgentPackage('@delorun/plugin-delegation-consent')).toBe(false)
    expect(isExternalAgentPackage('@delorun/external-agents-extra')).toBe(false)
  })

  it.each([...DELORUN_EXTERNAL_AGENT_PACKAGES])('refuses installing or enabling a bundle of %s, however it is spelt', (name) => {
    for (const target of [name, `${name}@0.1.0`, ` ${name.toUpperCase()} `, `x@npm:${name}`, `./node_modules/${name}`]) {
      expect(call({ action: 'install_bundle', target }), target).toBe(PLUGIN_MANAGER_REFUSAL)
      expect(call({ action: 'set_bundle', target, enabled: true }), target).toBe(PLUGIN_MANAGER_REFUSAL)
    }
  })

  it.each(['g1', 'external-agents', 'g2', 'agent-claude-code', ' g3 ', 'agent-codex', 'g4', 'agent-seats'])('refuses enabling or configuring the row %s', (target) => {
    expect(call({ action: 'set_plugin', target, enabled: true })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'configure', target, config: { maxLivePrograms: 99, limitRefusal: false } })).toBe(PLUGIN_MANAGER_REFUSAL)
  })

  it('lets disabling and removing through, which the gate turns into refused starts', () => {
    expect(call({ action: 'set_plugin', target: 'g1', enabled: false })).toBeUndefined()
    expect(call({ action: 'set_bundle', target: '@delorun/agent-codex', enabled: false })).toBeUndefined()
    expect(call({ action: 'remove_bundle', target: '@delorun/agent-claude-code' })).toBeUndefined()
    expect(call({ action: 'configure', target: 'g5', config: {} })).toBeUndefined()
  })
})
