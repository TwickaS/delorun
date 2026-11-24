/**
 * The hook-skip gate: no script, hook or workflow passes `--no-verify` to git or disables Lefthook, and the files that
 * state the rule, the gate's own fixtures and a product's own profile history are not read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ALLOWED, hookSkipRefusals, isRead, SKIP_FLAG, textRefusals } from '../../src/checks/gates/hook-skips.ts'

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
  const root = mkdtempSync(join(tmpdir(), 'delorun-hook-skips-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/**
 * The refusals of a fixture tree as `path:line` keys.
 * @param files - repository paths and their contents.
 * @returns one `path:line` per refusal.
 */
function lines(files: Record<string, string>): string[] {
  return hookSkipRefusals(tree(files)).map(({ path, line }) => `${path}:${String(line)}`)
}

describe('gates:hook-skips', () => {
  it('refuses the flag in a script, a hook configuration, a workflow and a manifest script', () => {
    expect(lines({
      'scripts/land.sh': `#!/bin/sh\ngit push ${SKIP_FLAG} origin main\n`,
      'delorun/lefthook.yml': 'pre-push:\n  jobs:\n    - run: git push --no-verify\n',
      '.github/workflows/ci.yml': 'jobs:\n  x:\n    steps:\n      - run: git commit --no-verify -m x\n',
      'package.json': '{ "scripts": { "land": "git push --no-verify" } }\n',
      'apps/desktop/scripts/run.sh': 'git push --no-verify\n',
    })).toEqual([
      '.github/workflows/ci.yml:4',
      'apps/desktop/scripts/run.sh:1',
      'delorun/lefthook.yml:3',
      'package.json:1',
      'scripts/land.sh:2',
    ])
  })

  it('refuses the variable that disables Lefthook', () => {
    expect(lines({
      'scripts/land.sh': 'LEFTHOOK=0 git push origin main\n',
      'lefthook.yml': 'pre-push:\n  jobs:\n    - run: LEFTHOOK=false git push\n',
    })).toEqual(['lefthook.yml:3', 'scripts/land.sh:1'])
  })

  it('passes a tree whose scripts run git through its hooks', () => {
    expect(lines({
      'scripts/land.sh': '#!/bin/sh\ngit push origin main\n',
      'lefthook.yml': 'pre-push:\n  jobs:\n    - run: pnpm run typecheck\n',
      'package.json': '{ "scripts": { "check": "tsx run-checks.ts" } }\n',
      'delorun/apps/tools/src/checks/gates/secrets.ts': 'export const x = 1\n',
    })).toEqual([])
  })

  it('does not read documentation that names the flag to forbid it', () => {
    expect(lines({
      'AGENTS.md': 'Never skip the pre-push hook with --no-verify.\n',
      'delorun/docs/guide/workflow.md': 'Never `--no-verify`.\n',
      '.agents/skills/dsh-pre-push-checks/SKILL.md': 'Never --no-verify.\n',
      'delorun/apps/tools/README.md': 'The tool never passes --no-verify.\n',
    })).toEqual([])
  })

  it('does not read its own source or spec, whose fixtures are the refusal matrix', () => {
    for (const path of ALLOWED) expect(isRead(path)).toBe(false)
    expect(lines({
      'delorun/apps/tools/src/checks/gates/hook-skips.ts': `export const SKIP_FLAG = '${SKIP_FLAG}'\n`,
      'delorun/apps/tools/tests/gates/hook-skips.spec.ts': `const flag = '${SKIP_FLAG}'\n`,
    })).toEqual([])
  })

  it('does not read a product source that commits to a person\'s own profile history', () => {
    expect(lines({
      'packages/boot/plugin-manager/src/history.ts': "await this.git(['commit', '--quiet', '--no-verify', '-m', summary])\n",
    })).toEqual([])
  })

  it('reads a shell script and a manifest anywhere in the tree, and skips the dependency trees', () => {
    expect(isRead('apps/web/scripts/build.sh')).toBe(true)
    expect(isRead('packages/llm/llm-pi-ai/package.json')).toBe(true)
    expect(isRead('delorun/apps/tools/scripts/full-set.sh')).toBe(true)
    expect(isRead('delorun/apps/tools/src/run-checks.ts')).toBe(false)
    expect(lines({
      'node_modules/dep/scripts/x.sh': 'git push --no-verify\n',
      'packages/a/lib/scripts/x.sh': 'git push --no-verify\n',
    })).toEqual([])
  })

  it('names the line and what it does', () => {
    expect(textRefusals('scripts/x.sh', 'a\ngit push --no-verify\n')).toEqual([
      { path: 'scripts/x.sh', line: 2, found: `passes ${SKIP_FLAG} to git` },
    ])
  })

  it('reads a tree with no scripts as clean', () => {
    expect(lines({ 'README.md': 'x\n' })).toEqual([])
  })
})
