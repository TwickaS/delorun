/**
 * The rule that a preview flag changes studio UI only, as far as this package can hold it: the package reaches no
 * session, model or tool package, so nothing here can put a flag into a model request, and the Host API has no way to
 * change a flag while Delorun runs, so a flag's value is the profile row's for the whole run.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createPreviewFlags } from '../src/registry.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/** Every source file of the package. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(entry) ? [path] : []
  })
}

/** The packages whose imports would let a flag reach a model request or a session log. */
const MODEL_FACING = /@deepseek-ai\/dsh-(?:session|llm|agent|tools?|system-prompt|context|compaction|preset|subagent|mcp|skill)(?:[-/'"]|$)/

describe('a preview flag changes studio UI only', () => {
  it('imports nothing that builds a model request, in sources and in the manifest', () => {
    // Pins the rule: an import of a session, model or tool package here is the first step of a flag reaching a model.
    const imports = sources(join(PACKAGE, 'src')).flatMap(file => [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map(match => match[1] ?? ''))
    expect(imports.length).toBeGreaterThan(10)
    expect(imports.filter(specifier => MODEL_FACING.test(specifier))).toEqual([])
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
    const dependencies = ['dependencies', 'peerDependencies', 'devDependencies'].flatMap(section => Object.keys(manifest[section] ?? {}))
    expect(dependencies.filter(name => MODEL_FACING.test(name))).toEqual([])
  })

  it('gives the Host no way to change a flag while Delorun runs', () => {
    // Pins the API: a setter would let a plugin, and so a tool call, turn a preview on mid-chat.
    const { flags } = createPreviewFlags({ configured: {}, index: undefined, rowOff: () => false })
    expect(Object.keys(flags).sort()).toEqual(['declare', 'isOn', 'list'])
  })
})
