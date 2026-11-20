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
    ['a CI checkout folder', '/builds/ci/x'],
    ['a workflow folder', '/__w/repo/x'],
    ['a Nix store folder', '/nix/store/abc-x'],
    ['a data folder', '/data/x'],
    ['a file URL with a host', 'file://host/share/x'],
  ])('refuses %s', (_label, value) => {
    const problems = machinePathProblems([file('package.json', { dependencies: { x: value } })])
    expect(problems).toEqual([expect.objectContaining({ file: 'package.json', field: 'dependencies.x', value })])
  })

  it.each([
    ['pnpm-workspace.yaml', 'patchedDependencies: {}\n'],
    ['node_modules/.modules.yaml', 'prunedAt: Fri, 20 Nov 2026 10:00:00 GMT\nstoreDir: /home/builder/.local/share/pnpm/store/v11\n'],
    ['node_modules/.pnpm-workspace-state-v1.json', '{"lastValidatedTimestamp":1763632800000}'],
    ['node_modules/.pnpm/lock.yaml', "lockfileVersion: '9.0'\n"],
    ['node_modules/.pnpm/x@1.0.0/node_modules/x/index.js', 'export {}\n'],
  ])('refuses pnpm deploy metadata at %s, which holds the build\'s paths and times', (path, body) => {
    expect(machinePathProblems([file(path, body)])).toEqual([expect.objectContaining({ file: path, names: expect.stringContaining('deploy metadata') })])
    expect(() => refuseMachinePaths('@a/b', 'linux-x64', [file(path, body)])).toThrow(new RegExp(`@a/b for linux-x64.*${path.replaceAll('.', '\\.')}`, 'u'))
  })

  it('does not take other dot files in node_modules for deploy metadata', () => {
    expect(machinePathProblems([file('node_modules/.package-lock.json', '{}'), file('node_modules/.pnpmfile/x.js', '')])).toEqual([])
  })

  it('refuses a bundled dependency that names a path, and a nested Delorun or vendor package that names one', () => {
    expect(machinePathProblems([file('package.json', { bundleDependencies: ['/tmp/x'] })])).toEqual([expect.objectContaining({ field: 'bundleDependencies.0', value: '/tmp/x' })])
    expect(machinePathProblems([file('node_modules/@delorun/a/node_modules/@deepseek-ai/b/package.json', { dependencies: { c: 'link:/tmp/c' } })])).toEqual([expect.objectContaining({ file: 'node_modules/@delorun/a/node_modules/@deepseek-ai/b/package.json', field: 'dependencies.c' })])
  })

  it('refuses an absolute lockfile directory outside the usual roots', () => {
    expect(machinePathProblems([file('pnpm-lock.yaml', 'packages:\n  x@1.0.0:\n    resolution: {directory: /builds/x, type: directory}\n')])).toEqual([expect.objectContaining({ field: 'packages > x@1.0.0 > resolution > directory', value: '/builds/x' })])
  })

  it('names the pack, the platform, the file and the field, and counts the rest', () => {
    const entries = [file('package.json', { dependencies: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`d${String(index)}`, `file:/tmp/d${String(index)}`])) })]
    expect(() => refuseMachinePaths('@a/b', 'linux-x64', entries)).toThrow(/@a\/b for linux-x64 carries 7 paths.*package\.json dependencies\.d0: file:\/tmp\/d0.*and 2 more/u)
    expect(() => refuseMachinePaths('@a/b', 'linux-x64', [file('package.json', { dependencies: { a: '1.0.0' } })])).not.toThrow()
  })
})
