/**
 * The manifest reader: what the report learns from a plugin's own `package.json`, and what it refuses to learn from.
 * C3's `manifest-unreadable` and `requirement-unreadable` are the two ways a manifest withholds a fact, and they are
 * different: one cannot be read at all, the other is declared in a form that is not a range.
 */
import { describe, expect, it } from 'vitest'
import { readInstalledPlugin, type PluginRequirements } from '../src/index.ts'
import { version } from './support.ts'

/**
 * The declarations one manifest text yields.
 * @param text - the `package.json` text.
 * @returns both axes' declarations, or undefined when the manifest does not parse.
 */
function requirementsOf(text: string): PluginRequirements | undefined {
  return readInstalledPlugin('plugin', version('1.0.0'), text).requirements
}

describe('readInstalledPlugin', () => {
  it('reads both ranges from engines', () => {
    expect(requirementsOf('{"engines":{"dsh":"^0.3.0","delo":">=1.0.0"}}')).toEqual({ dsh: { kind: 'range', range: '^0.3.0' }, delo: { kind: 'range', range: '>=1.0.0' } })
  })

  it('takes the identity from the profile, not from the manifest', () => {
    const plugin = readInstalledPlugin('plugin', version('1.0.0'), '{"name":"another","version":"9.9.9"}')
    expect(plugin.name).toBe('plugin')
    expect(plugin.version).toBe('1.0.0')
  })

  it('reports a declaration that is not a string as unreadable, and the absent axis as none', () => {
    expect(requirementsOf('{"engines":{"dsh":42}}')).toEqual({ dsh: { kind: 'unreadable' }, delo: { kind: 'none' } })
    expect(requirementsOf('{"engines":{"delo":["^1.0.0"]}}')).toEqual({ dsh: { kind: 'none' }, delo: { kind: 'unreadable' } })
  })

  it('reports an engines field that is not an object as unreadable on both axes', () => {
    expect(requirementsOf('{"engines":"^0.3.0"}')).toEqual({ dsh: { kind: 'unreadable' }, delo: { kind: 'unreadable' } })
  })

  it('reports no declarations for a manifest without engines', () => {
    expect(requirementsOf('{"name":"plugin"}')).toEqual({ dsh: { kind: 'none' }, delo: { kind: 'none' } })
  })

  it('leaves the requirements absent when the bytes do not parse or are not an object', () => {
    for (const text of ['{"engines":', '', 'null', '[]', '"a string"', '42']) {
      expect(readInstalledPlugin('plugin', version('1.0.0'), text).requirements).toBeUndefined()
    }
  })

  it('reads bytes as well as text', () => {
    const bytes = new TextEncoder().encode('{"engines":{"dsh":"^0.3.0"}}')
    expect(readInstalledPlugin('plugin', version('1.0.0'), bytes).requirements?.dsh).toEqual({ kind: 'range', range: '^0.3.0' })
  })
})
