/**
 * C20 requirement 7: `delorun` never writes upstream's raw `startup-*.log` report. Only upstream's `dsh` entry reaches
 * the code that writes it, so no Delorun module may import that entry or the report writer.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DELO = fileURLToPath(new URL('../../../../', import.meta.url))

/** Every TypeScript source file under the Delorun packages and apps, not their tests. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'lib' || name === 'tests') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('requirement 7: no startup report', () => {
  it('has no Delorun module that imports upstream\'s dsh entry or its startup report writer', () => {
    const reaching = [...sources(join(DELO, 'apps')), ...sources(join(DELO, 'packages'))].filter(path => /startup-diagnostics|dsh\/bin|reportStartupFailure/.test(readFileSync(path, 'utf8')) && !path.endsWith('startup-reports.spec.ts'))
    expect(reaching).toEqual([])
  })
})
