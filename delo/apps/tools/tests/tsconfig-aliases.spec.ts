import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readManifest } from '../src/check-fork-boundary.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * Remove the comments and trailing commas of a JSONC document, leaving string contents unchanged.
 * @param text - the JSONC text.
 * @returns JSON text that `JSON.parse` accepts.
 */
function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (inString) {
      out += char
      if (char === '\\') {
        out += text.charAt(index + 1)
        index += 1
      } else if (char === '"') {
        inString = false
      }
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text.charAt(index + 1) === '/') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end - 1
    } else if (char === '/' && text.charAt(index + 1) === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 1
    } else if (char !== ',' || !/^\s*[}\]]/u.test(text.slice(index + 1, index + 1 + 64))) {
      out += char
    }
  }
  return out
}

const paths = z.object({ compilerOptions: z.object({ paths: z.record(z.string(), z.unknown()) }) })

/**
 * The `paths` alias names a tsconfig declares.
 * @param text - the tsconfig's JSONC text.
 * @returns every alias key, in file order.
 */
function aliasesOf(text: string): string[] {
  return Object.keys(paths.parse(JSON.parse(stripJsonc(text))).compilerOptions.paths)
}

describe('tsconfig.base.json', () => {
  it('keeps every paths alias that the pinned upstream commit defines', () => {
    const { upstream } = readManifest(root)
    const upstreamText = execFileSync('git', ['show', `${upstream.commit}:tsconfig.base.json`], { cwd: root, encoding: 'utf8' })
    const current = new Set(aliasesOf(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')))
    expect(aliasesOf(upstreamText).length).toBeGreaterThan(0)
    expect(aliasesOf(upstreamText).filter(alias => !current.has(alias))).toEqual([])
  })
})
