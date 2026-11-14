/**
 * The manifest reader: what the report learns from a plugin's own `package.json`, and what it refuses to learn from.
 * A manifest that cannot be read as a JSON object is C3's `manifest-unreadable`; one that reads is kept whole for
 * upstream's evaluation, which decides `requirement-unreadable` itself.
 */
import { describe, expect, it } from 'vitest'
import { readInstalledPlugin } from '../src/index.ts'
import { version } from './support.ts'

describe('readInstalledPlugin', () => {
  it('keeps the manifest as it reads', () => {
    expect(readInstalledPlugin('plugin', version('1.0.0'), '{"engines":{"dsh":"^0.3.0","delorun":">=1.0.0"}}').manifest).toEqual({ engines: { dsh: '^0.3.0', delorun: '>=1.0.0' } })
  })

  it('takes the identity from the profile, not from the manifest', () => {
    const plugin = readInstalledPlugin('plugin', version('1.0.0'), '{"name":"another","version":"9.9.9"}')
    expect(plugin.name).toBe('plugin')
    expect(plugin.version).toBe('1.0.0')
  })

  it('leaves the manifest absent when the bytes do not parse or are not an object', () => {
    for (const text of ['{"engines":', '', 'null', '[]', '"a string"', '42']) {
      expect(readInstalledPlugin('plugin', version('1.0.0'), text).manifest).toBeUndefined()
    }
  })

  it('reads bytes as well as text', () => {
    const bytes = new TextEncoder().encode('{"engines":{"dsh":"^0.3.0"}}')
    expect(readInstalledPlugin('plugin', version('1.0.0'), bytes).manifest).toEqual({ engines: { dsh: '^0.3.0' } })
  })
})
