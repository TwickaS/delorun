import { describe, expect, it } from 'vitest'
import { parseDesktopHomeKind } from '../src/ipc.ts'

describe('parseDesktopHomeKind', () => {
  it.each(['bundled', 'wsl', 'remote'] as const)('reads %s', (kind) => {
    expect(parseDesktopHomeKind(kind)).toBe(kind)
  })

  it.each([undefined, null, '', 'local', 'WSL', 7, true, ['wsl'], { kind: 'wsl' }])('does not read %j', (value) => {
    expect(parseDesktopHomeKind(value)).toBeUndefined()
  })
})
