/**
 * The source files the package publishes: every file an exported `src/` module imports by a relative path is listed in
 * `files`, because the runtime closure carries only listed files and loads these modules from source.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, string | object>; files: string[] }

/**
 * The files a module reaches by relative imports, transitively.
 * @param file - a path relative to the package root.
 * @param seen - the files already visited.
 * @returns the visited files.
 */
function reached(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen
  seen.add(file)
  const text = readFileSync(join(ROOT, file), 'utf8')
  for (const [, specifier] of text.matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+\.ts)'/gu)) reached(relative(ROOT, join(ROOT, dirname(file), specifier!)), seen)
  return seen
}

describe('the published source modules', () => {
  it('list every file their relative imports reach', () => {
    const sources = Object.values(manifest.exports).filter((target): target is string => typeof target === 'string' && target.startsWith('./src/')).map(target => target.slice(2))
    const missing = [...new Set(sources.flatMap(source => [...reached(source)]))].filter(file => !manifest.files.includes(file))
    expect(missing).toEqual([])
  })
})
