/**
 * Proves that the trash path derivations refuse unusable input and escape every
 * unsafe code unit: an empty id or project path, the whole-segment tokens `.`
 * and `..`, characters outside the safe set, a project path made only of
 * separators, and an attachment digest that is not a lowercase SHA-256.
 */
import { describe, expect, it } from 'vitest'
import { attachmentObjectPath, encodeSegment, projectKey } from '../src/paths.ts'

describe('encodeSegment', () => {
  it('refuses an empty id', () => {
    expect(() => encodeSegment('')).toThrow('cannot encode an empty path segment')
  })

  it('escapes the whole-segment tokens so an id cannot traverse', () => {
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('..')).toBe('~002E~002E')
  })

  it('escapes the escape character and every code unit outside the safe set', () => {
    expect(encodeSegment('a b/c~d')).toBe('a~0020b~002Fc~007Ed')
  })
})

describe('projectKey', () => {
  it('refuses an empty project path', () => {
    expect(() => projectKey('')).toThrow('cannot encode an empty project path')
  })

  it('collapses separator runs and escapes unsafe code units', () => {
    expect(projectKey('/home//my proj~x')).toBe('--home-my~0020proj~007Ex--')
  })

  it('names a project path made only of separators root', () => {
    expect(projectKey('///')).toBe('--root--')
  })
})

describe('attachmentObjectPath', () => {
  it('refuses a digest that is not a lowercase SHA-256', () => {
    expect(() => attachmentObjectPath('/attachments/v1', 'ABC')).toThrow('attachment digest is not a lowercase sha256')
  })

  it('places an object under its first digest byte pair', () => {
    const digest = 'ab'.repeat(32)
    expect(attachmentObjectPath('/attachments/v1', digest)).toBe(`/attachments/v1/objects/ab/${digest}`)
  })
})
