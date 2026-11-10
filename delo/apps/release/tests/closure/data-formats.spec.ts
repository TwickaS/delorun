/**
 * The closure's `data-formats.json`: written at the stage's root from the checkout's schema inventory, never over an
 * existing file, and listed in the platform's signed file list like every other staged file.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDataFormats } from '@delo/update/data-formats'
import { listStagedTree } from '../../src/closure/tree.ts'
import { PERSISTENCE_SCHEMA_PATH, writeDataFormats } from '../../src/closure/data-formats.ts'
import { scratch } from '../support.ts'

describe('writeDataFormats', () => {
  it('writes the schema digest at the stage root, where the file list includes it', async (test) => {
    const root = scratch(test)
    const source = join(root, 'source')
    const stage = join(root, 'stage')
    mkdirSync(join(source, 'docs'), { recursive: true })
    mkdirSync(join(stage, 'app'), { recursive: true })
    writeFileSync(join(source, PERSISTENCE_SCHEMA_PATH), '{"formatVersion":2}\n')
    writeFileSync(join(stage, 'app/package.json'), '{}\n')
    const path = await writeDataFormats(stage, source)
    const formats = parseDataFormats(readFileSync(path, 'utf8'))
    expect(formats.persistence).toBe(createHash('sha256').update('{"formatVersion":2}\n').digest('hex'))
    expect((await listStagedTree(stage, 'linux-x64')).map(file => file.path)).toContain('data-formats.json')
    await expect(writeDataFormats(stage, source)).rejects.toThrow(/EEXIST/u)
  })

  it('refuses a checkout without the schema inventory', async (test) => {
    const root = scratch(test)
    mkdirSync(join(root, 'stage'))
    await expect(writeDataFormats(join(root, 'stage'), root)).rejects.toThrow(/ENOENT/u)
  })
})
