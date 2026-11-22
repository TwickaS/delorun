/** The web server row of the studio's port. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { setPatchRow } from '../src/patch-file.ts'
import { BROWSER_BLOCKED_PORTS, STUDIO_ROW_ID, studioPortProblem, studioRow } from '../src/studio-row.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('the studio row', () => {
  it('restates the web server row\'s other keys with the port, because a patch row replaces the whole config', () => {
    expect(studioRow(4100)).toEqual({ id: STUDIO_ROW_ID, config: { host: '127.0.0.1', port: 4100, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
  })

  it('writes into a profile patch as the profile section does', () => {
    const root = mkdtempSync(join(tmpdir(), 'delorun-studio-row-'))
    roots.push(root)
    const path = join(root, 'cordis.patch.yml')
    setPatchRow(path, studioRow(4200))
    expect(parse(readFileSync(path, 'utf8'))).toEqual([studioRow(4200)])
  })
})

describe('the studio port', () => {
  it('refuses each port web browsers block and the port phone access listens on, and accepts others', () => {
    expect([...BROWSER_BLOCKED_PORTS].sort((a, b) => a - b)).toEqual([6000, 6665, 6666, 6667, 6668, 6669, 6697, 10_080])
    for (const port of BROWSER_BLOCKED_PORTS) expect(studioPortProblem(port), String(port)).toContain('blocked by web browsers')
    expect(studioPortProblem(4500, 4500)).toContain('phone access listens on')
    expect(studioPortProblem(3080)).toBeUndefined()
    expect(studioPortProblem(3080, 4500)).toBeUndefined()
    // 0 means the listener has no port yet, so no studio port matches it.
    expect(studioPortProblem(3080, 0)).toBeUndefined()
  })
})
