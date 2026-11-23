import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const renames: string[] = []
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: (from: string, to: string) => { renames.push(to); actual.renameSync(from, to) } }
})

const { writePromptRows, PROMPT_SWITCH_ROWS } = await import('../src/prompt-rows.ts')

let directory: string
beforeEach(() => {
  renames.length = 0
  directory = mkdtempSync(join(tmpdir(), 'delorun-prompt-rows-write-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('writing the prompts answer', () => {
  it('replaces the patch file once for all the settings, so a failure cannot leave some changed and some not', () => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, '[]\n')
    writePromptRows(path, 'stock')
    expect(renames).toEqual([path])
    expect((parse(readFileSync(path, 'utf8')) as { id: string }[]).map(row => row.id).sort()).toEqual([...new Set(Object.values(PROMPT_SWITCH_ROWS))].sort())
  })
})
