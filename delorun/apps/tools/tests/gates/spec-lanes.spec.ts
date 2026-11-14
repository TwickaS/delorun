import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ALLOW_MARKER, isUnitSpec, specLaneViolations } from '../../src/checks/gates/spec-lanes.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A fixture repository holding the given files.
 * @param files - repository paths and their contents.
 * @returns its root.
 */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'delorun-spec-lanes-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/**
 * The violations of a fixture tree as `path:line` keys.
 * @param files - repository paths and their contents.
 * @returns one `path:line` per violation.
 */
function lines(files: Record<string, string>): string[] {
  return specLaneViolations(tree(files)).map(({ path, line }) => `${path}:${String(line)}`)
}

const SPAWNING_HELPER = "import { execFileSync } from 'node:child_process'\nexport const REPO = '/r'\nexport type Run = string\nexport const run = (): string => execFileSync('git', ['status'], { timeout: 1 }).toString()\n"

describe('gates:spec-lanes', () => {
  it('names the unit specs by their file names', () => {
    expect(isUnitSpec('delorun/apps/a/tests/x.spec.ts')).toBe(true)
    expect(isUnitSpec('delorun/apps/a/tests/x.client.spec.tsx')).toBe(true)
    expect(isUnitSpec('delorun/apps/a/tests/x.integration.spec.ts')).toBe(false)
    expect(isUnitSpec('delorun/apps/a/tests/x.docker.spec.ts')).toBe(false)
    expect(isUnitSpec('delorun/apps/a/tests/support.ts')).toBe(false)
  })

  it('passes a unit spec that starts no process and an integration spec whose process calls have timeouts', () => {
    expect(specLaneViolations(tree({
      'delorun/apps/a/tests/pure.spec.ts': "import { readFileSync } from 'node:fs'\nimport { REPO, type Run } from './support.ts'\nimport type { Other } from './support.ts'\nconst command = ['node_modules/.bin/tsx', 'x.ts']\nconst pattern = /x/.exec('x')\n",
      'delorun/apps/a/tests/support.ts': SPAWNING_HELPER,
      'delorun/apps/a/tests/real.integration.spec.ts': "import * as cp from 'node:child_process'\nimport { run } from './support.ts'\nconst timeout = 5\ncp.spawnSync('git', [], { cwd: '/', timeout })\ncp.execSync('true', { timeout: 1 })\n",
      'delorun/apps/a/tests/ui.client.spec.tsx': "import { render } from './render.ts'\nimport { Comp } from './comp'\nconst views = [() => <div>tsx</div>]\nexport const view = views[0]?.()\nconst name = './render.ts'\nawait import(name)\n",
      'delorun/apps/a/tests/comp.tsx': 'export const Comp = (): JSX.Element => <span />\n',
      'delorun/apps/a/tests/render.ts': 'export const render = (): void => undefined\n',
      'delorun/apps/a/tests/node_modules/dep/index.ts': "import { spawnSync } from 'node:child_process'\nspawnSync('x')\n",
      'delorun/apps/a/tests/.cache/note.ts': "import { spawnSync } from 'node:child_process'\nspawnSync('x')\n",
      'delorun/apps/a/tests/types.d.ts': "declare function spawnSync(command: string): void\nspawnSync('x')\n",
      'delorun/apps/a/tests/notes.md': 'spawnSync(x)\n',
      'delorun/apps/a/tests/nested/deeper.spec.ts': "import { REPO } from '../support.ts'\nexport const root = REPO\n",
      'delorun/apps/a/README.md': 'no tests here\n',
      'delorun/packages/b/src/spawn.ts': "import { spawnSync } from 'node:child_process'\nexport const go = () => spawnSync('x')\n",
      'delorun/packages/b/tests/uses-src.spec.ts': "import { go } from '../src/spawn.ts'\nimport { missing } from './missing.ts'\nimport { other } from './other.spec.ts'\nexport { go }\n",
      'delorun/packages/b/tests/other.spec.ts': 'export const other = 1\n',
      'delorun/packages/c/package.json': '{}\n',
    }))).toEqual([])
  })

  it('refuses a unit spec that imports child_process, runs git, loads tsx in a child or imports a helper that starts processes', () => {
    const violations = specLaneViolations(tree({
      'delorun/apps/a/tests/one.spec.ts': "import { spawn } from 'node:child_process'\nexport const x = 1\n",
      'delorun/apps/a/tests/two.spec.ts': "const git = (args: string[]): string => args.join(' ')\ngit(['status'])\nconst loader = import.meta.resolve('tsx/esm')\nawait import('child_process')\n",
      'delorun/apps/a/tests/three.spec.ts': "import { run } from './support.ts'\nimport * as all from './support'\nimport whole from './support.ts'\nimport './support.ts'\nexport * from './support.ts'\n",
      'delorun/apps/a/tests/four.client.spec.tsx': "import { chain } from './chain.ts'\nexport const view = <div>{chain}</div>\n",
      'delorun/apps/a/tests/chain.ts': "export { run as chain } from './support.ts'\n",
      'delorun/apps/a/tests/support.ts': SPAWNING_HELPER,
      'delorun/apps/a/tests/five.spec.ts': "import { helper } from '../src/tests/helper.ts'\n",
      'delorun/apps/a/src/tests/helper.ts': "export { spawnSync as helper } from 'node:child_process'\n",
    }))
    expect(violations.map(({ path, line, message }) => `${path}:${String(line)}: ${message.split(';')[0] ?? ''}`)).toEqual([
      'delorun/apps/a/tests/five.spec.ts:1: a unit spec imports ../src/tests/helper.ts, which starts processes',
      'delorun/apps/a/tests/four.client.spec.tsx:1: a unit spec imports ./chain.ts, which starts processes',
      'delorun/apps/a/tests/one.spec.ts:1: a unit spec imports node:child_process',
      'delorun/apps/a/tests/three.spec.ts:1: a unit spec imports ./support.ts, which starts processes',
      'delorun/apps/a/tests/three.spec.ts:2: a unit spec imports ./support, which starts processes',
      'delorun/apps/a/tests/three.spec.ts:3: a unit spec imports ./support.ts, which starts processes',
      'delorun/apps/a/tests/three.spec.ts:4: a unit spec imports ./support.ts, which starts processes',
      'delorun/apps/a/tests/three.spec.ts:5: a unit spec imports ./support.ts, which starts processes',
      'delorun/apps/a/tests/two.spec.ts:2: a unit spec runs git',
      'delorun/apps/a/tests/two.spec.ts:3: a unit spec loads TypeScript in a child process (tsx/esm)',
      'delorun/apps/a/tests/two.spec.ts:4: a unit spec imports child_process',
    ])
    expect(violations[0]?.message).toContain('rename the spec to *.integration.spec.ts, which runs in the fork-integration project')
  })

  it('refuses a synchronous process call without a literal timeout in any file under a tests directory', () => {
    const violations = specLaneViolations(tree({
      'delorun/apps/a/tests/real.integration.spec.ts': "import cp, { execFileSync, spawnSync } from 'node:child_process'\nconst options = { timeout: 1 }\nspawnSync('git', ['x'])\nexecFileSync('git', ['x'], options)\ncp.execSync('true', { ...options })\nspawnSync('git', [], { cwd: '/', timeout: 5 })\n",
      'delorun/packages/b/tests/support.ts': "import { execSync } from 'node:child_process'\nexport const x = execSync('true', { encoding: 'utf8' })\n",
      'delorun/packages/b/tests/b.docker.spec.ts': "import { spawnSync } from 'node:child_process'\nspawnSync('docker')\n",
    }))
    expect(violations.map(({ path, line }) => `${path}:${String(line)}`)).toEqual([
      'delorun/apps/a/tests/real.integration.spec.ts:3',
      'delorun/apps/a/tests/real.integration.spec.ts:4',
      'delorun/apps/a/tests/real.integration.spec.ts:5',
      'delorun/packages/b/tests/b.docker.spec.ts:2',
      'delorun/packages/b/tests/support.ts:2',
    ])
    expect(violations[0]?.message).toBe(`spawnSync without a literal \`timeout\` option; give it one so a hung child fails the test, or add \`// ${ALLOW_MARKER} <reason>\``)
  })

  it('exempts the line that carries the allow comment with a reason, and the line below it', () => {
    expect(lines({
      'delorun/apps/a/tests/allowed.spec.ts': [
        `// ${ALLOW_MARKER} the probe decides a skip and starts nothing else`,
        "import { spawnSync } from 'node:child_process'",
        `spawnSync('bwrap', ['--version']) // ${ALLOW_MARKER} a probe of one binary`,
        `import { run } from './support.ts' // ${ALLOW_MARKER} reads the helper's constant set`,
        `// ${ALLOW_MARKER}`,
        "spawnSync('git')",
      ].join('\n'),
      'delorun/apps/a/tests/support.ts': SPAWNING_HELPER,
    })).toEqual(['delorun/apps/a/tests/allowed.spec.ts:6'])
  })

  it('follows helpers that import each other in a cycle without looping', () => {
    expect(lines({
      'delorun/apps/a/tests/x.spec.ts': "import { a } from './a.ts'\n",
      'delorun/apps/a/tests/a.ts': "import { b } from './b.ts'\nexport const a = b\n",
      'delorun/apps/a/tests/b.ts': "import { a } from './a.ts'\nexport const b = a\n",
      'delorun/apps/a/tests/y.spec.ts': "import { c } from './c.ts'\n",
      'delorun/apps/a/tests/c.ts': "import { d } from './d.ts'\nexport const c = d\n",
      'delorun/apps/a/tests/d.ts': "import { c } from './c.ts'\nimport { spawn } from 'node:child_process'\nexport const d = spawn\n",
    })).toEqual(['delorun/apps/a/tests/y.spec.ts:1'])
  })

  it('reads a tree with no Delorun apps or packages as clean', () => {
    expect(lines({ 'README.md': 'x\n' })).toEqual([])
    expect(lines({ 'delorun/apps/a/tests/x.spec.ts': 'export {}\n' })).toEqual([])
  })
})
