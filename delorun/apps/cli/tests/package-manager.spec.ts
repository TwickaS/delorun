import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { CliError } from '../src/exit.ts'
import { CLOSURE_PNPM_ENTRY, closureRootOf, packageManagerFor } from '../src/package-manager.ts'

/** A runtime closure's root with its `delorun` entry file, and its pnpm unless `pnpm` is false. */
function closure(test: TestContext, pnpm: boolean): { readonly root: string, readonly entry: string } {
  const root = mkdtempSync(join(tmpdir(), 'delorun-closure-pm-'))
  test.onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const entry = join(root, 'app', 'node_modules', '@delorun', 'cli', 'src', 'bin.js')
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, '')
  if (pnpm) {
    mkdirSync(join(root, 'pnpm', 'bin'), { recursive: true })
    writeFileSync(join(root, ...CLOSURE_PNPM_ENTRY.split('/')), '')
  }
  return { root, entry }
}

describe('the pnpm of upstream\'s package operations', () => {
  it('runs the closure\'s own pnpm with the closure\'s Node, which leads PATH', (test) => {
    const { root, entry } = closure(test, true)
    const node = join(root, 'node', 'bin', 'node')
    expect(closureRootOf(entry)).toBe(root)
    expect(packageManagerFor({ entry, execPath: node, path: `${sep}usr${sep}bin` })).toEqual({
      command: node,
      args: [join(root, 'pnpm', 'bin', 'pnpm.cjs')],
      env: { PATH: `${join(root, 'node', 'bin')}${delimiter}${sep}usr${sep}bin` },
    })
    expect(packageManagerFor({ entry, execPath: node, path: undefined })?.env).toEqual({ PATH: join(root, 'node', 'bin') })
  })

  it('leaves a source checkout to the pnpm on PATH', () => {
    const entry = join(sep, 'work', 'delorun', 'apps', 'cli', 'src', 'bin.js')
    expect(closureRootOf(entry)).toBeUndefined()
    expect(packageManagerFor({ entry, execPath: process.execPath, path: '' })).toBeUndefined()
  })

  it('refuses a closure without its pnpm instead of falling back to one on PATH', (test) => {
    const { entry } = closure(test, false)
    expect(() => packageManagerFor({ entry, execPath: process.execPath, path: '' })).toThrow(CliError)
    expect(() => packageManagerFor({ entry, execPath: process.execPath, path: '' })).toThrow(/lacks its pnpm .*; reinstall Delorun/u)
  })
})
