import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALLOW_STANDINS_VARIABLE, MARKETED_RELEASE, replicaOptions } from '../replica-options.ts'

const COMMITTED = ['../replica-options.ts', '../vite.config.ts', '../../../vitest.config.ts', '../alchemy.run.ts']

describe('the replica plugins\' committed options', () => {
  it('name the marketed release and no way to allow stand-ins', () => {
    expect(replicaOptions()).toEqual({ aliases: expect.any(Array), release: MARKETED_RELEASE })
    expect(Object.keys(replicaOptions()).sort()).toEqual(['aliases', 'release'])
  })

  it('set the stand-in variable nowhere in a committed configuration', () => {
    for (const file of COMMITTED) {
      const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      const assignments = text.split('\n').filter(line => line.includes(ALLOW_STANDINS_VARIABLE) && /[=:]\s*['"`]?1/.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      expect(assignments, file).toEqual([])
    }
  })
})
