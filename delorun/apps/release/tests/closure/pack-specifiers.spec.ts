import { describe, expect, it } from 'vitest'
import { machinePathProblems, refuseMachinePaths } from '../../src/closure/pack-specifiers.ts'

const file = (path: string, body: unknown): { path: string, data: Buffer } => ({ path, data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) })

describe('the check for machine paths in a pack\'s metadata', () => {
  it('passes registry, workspace, alias and in-pack specifiers, tarball URLs and prose', () => {
    const lock = "lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: {integrity: sha512-A/B+C==, tarball: https://registry.npmjs.org/a/-/a-1.0.0.tgz}\n    deprecated: see /home/docs for ../why\n  b@file:node_modules/b:\n    resolution: {directory: node_modules/b, type: directory}\n"
    expect(machinePathProblems([
      file('package.json', { name: 'p', description: 'lives in /home/x', dependencies: { a: '^1.0.0', b: 'workspace:*', c: 'npm:a@1.0.0', d: 'git+https://github.com/o/r.git#abc', e: 'file:node_modules/e' }, peerDependencies: { f: '*' } }),
      file('pnpm-lock.yaml', lock),
      file('lib/index.js', 'export const where = "/home/x"\n'),
      file('node_modules/leftpad/package.json', { dependencies: { z: 'file:/tmp/z' } }),
    ])).toEqual([])
  })

  it.each([
    ['a file:// URL', 'file:///var/tmp/delorun-release-build-ab12/source/x'],
    ['an absolute path', '/home/user/source/x'],
    ['a macOS home folder', 'link:/Users/someone/x'],
    ['a Windows drive path', 'C:\\Users\\someone\\x'],
    ['a path outside the pack', '../../x'],
    ['a build folder', 'delorun-release-build-ab12'],
  ])('refuses %s', (_label, value) => {
    const problems = machinePathProblems([file('package.json', { dependencies: { x: value } })])
    expect(problems).toEqual([expect.objectContaining({ file: 'package.json', field: 'dependencies.x', value })])
  })

  it('refuses a workspace file, which holds the source\'s patch paths', () => {
    expect(machinePathProblems([file('pnpm-workspace.yaml', 'patchedDependencies: {}\n')])).toEqual([expect.objectContaining({ file: 'pnpm-workspace.yaml' })])
  })

  it('names the pack, the platform, the file and the field, and counts the rest', () => {
    const entries = [file('package.json', { dependencies: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`d${String(index)}`, `file:/tmp/d${String(index)}`])) })]
    expect(() => refuseMachinePaths('@a/b', 'linux-x64', entries)).toThrow(/@a\/b for linux-x64 carries 7 paths.*package\.json dependencies\.d0: file:\/tmp\/d0.*and 2 more/u)
    expect(() => refuseMachinePaths('@a/b', 'linux-x64', [file('package.json', { dependencies: { a: '1.0.0' } })])).not.toThrow()
  })
})
