import { describe, expect, it } from 'vitest'
import { missingClaudeSandboxTools } from '../src/safety-level.ts'

describe('missingClaudeSandboxTools', () => {
  it('needs nothing on macOS and reports every tool as missing where no sandbox exists', () => {
    expect(missingClaudeSandboxTools('darwin', undefined)).toEqual([])
    expect(missingClaudeSandboxTools('win32', '/bin')).toEqual(['sandbox'])
  })

  it('names the Linux tools that are not on PATH', () => {
    const only = (name: string) => (file: string): boolean => file === `/usr/bin/${name}`
    expect(missingClaudeSandboxTools('linux', '/opt:/usr/bin', only('bwrap'))).toEqual(['socat'])
    expect(missingClaudeSandboxTools('linux', '/usr/bin', () => true)).toEqual([])
    expect(missingClaudeSandboxTools('linux', undefined, () => true)).toEqual(['bwrap', 'socat'])
  })

  it('looks at the real file system by default', () => {
    expect(missingClaudeSandboxTools('linux', '/definitely/not/a/dir')).toEqual(['bwrap', 'socat'])
  })
})
