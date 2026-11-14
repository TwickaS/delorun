import { describe, expect, it } from 'vitest'
import { ADAPTERS, selectAdapter, type BrowseDeps } from '../../src/studio-browser/index.ts'

const DEPS: BrowseDeps = {
  run: () => ({ status: 0, stdout: '', stderr: '' }),
  env: {},
  randomHex: () => '00000000',
  writeTemp: () => '/tmp/x.js',
  removeTemp: () => undefined,
}

describe('selectAdapter', () => {
  it('creates the browse adapter', () => {
    expect(Object.keys(ADAPTERS)).toEqual(['browse'])
    expect(selectAdapter('browse', DEPS).id).toBe('browse')
  })

  it.each(['playwright', 'toString', ''])('refuses unknown id "%s" and lists the known ids', id => {
    expect(() => selectAdapter(id, DEPS)).toThrow(`unknown studio-browser adapter "${id}"; known adapters: browse`)
  })
})
