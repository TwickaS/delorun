import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadView } from '../../../packages/site-design/src/changelog.ts'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALLOW_STANDINS_VARIABLE, marketedRelease, replicaOptions } from '../replica-options.ts'

const COMMITTED = ['../replica-options.ts', '../vite.config.ts', '../../../vitest.config.ts', '../alchemy.run.ts']

describe('the replica plugins\' committed options', () => {
  const ROOT = resolve(import.meta.dirname, '../../../..')

  it('name the marketed release, the changelog\'s newest version, and no way to allow stand-ins', () => {
    const options = replicaOptions(ROOT)
    expect(options.release).toBe(loadView(ROOT)?.versions[0]?.version)
    expect(options.release).not.toBe('0.1.0')
    expect(Object.keys(options).sort()).toEqual(['aliases', 'release'])
  })

  it('refuse a repository whose changelog record has no version', () => {
    const empty = mkdtempSync(join(tmpdir(), 'release-'))
    try {
      mkdirSync(join(empty, 'delorun', 'changelog'), { recursive: true })
      expect(() => marketedRelease(empty)).toThrow(/no version/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('set the stand-in variable nowhere in a committed configuration', () => {
    for (const file of COMMITTED) {
      const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      const assignments = text.split('\n').filter(line => line.includes(ALLOW_STANDINS_VARIABLE) && /[=:]\s*['"`]?1/.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      expect(assignments, file).toEqual([])
    }
  })
})
