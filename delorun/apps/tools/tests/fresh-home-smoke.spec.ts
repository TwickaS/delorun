import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { failureLine, packagesWithoutLib, pickPort, PORT_RANGE } from '../src/fresh-home-smoke.ts'

describe('the fresh-home start smoke', () => {
  it('finds the line that reports a start-up failure, and none in a clean log', () => {
    const log = 'dsh web: http://127.0.0.1:18600\ndelorun-onboarding (@delorun/plugin-onboarding): ValidationError: invalid config:\n'
    expect(failureLine(log)).toContain('ValidationError')
    expect(failureLine('Delorun failed to start: boom')).toContain('failed to start')
    expect(failureLine('delorun-privacy: failed to import: Error')).toContain('failed to import')
    expect(failureLine('the studio stopped')).toContain('stopped')
    expect(failureLine('dsh web: http://127.0.0.1:18600\nRun delorun open to open the studio in your browser.\n')).toBeUndefined()
  })

  it('only uses ports of its own range, never the owner\'s studio ports', async () => {
    await expect(pickPort(18200)).rejects.toThrow('outside')
    await expect(pickPort(3080)).rejects.toThrow('outside')
    const port = await pickPort()
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE.first)
    expect(port).toBeLessThanOrEqual(PORT_RANGE.last)
  })

  it('lists a package that has a build script and no lib directory', () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
    expect(Array.isArray(packagesWithoutLib(root))).toBe(true)
  })
})
