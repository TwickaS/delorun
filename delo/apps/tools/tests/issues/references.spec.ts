import { describe, expect, it } from 'vitest'
import { referenceContext, referenceErrors, urlProblem } from '../../src/issues/references.ts'

const context = referenceContext([
  'AGENTS.md',
  'delo/docs/contracts/README.md',
  'delo/apps/tools/src/issues/brief.ts',
  'delo/apps/tools/src/checks/gates/doc-times.ts',
  'delo/docs/plans/private-plan.md',
  'packages/example/index.ts',
])

describe('public URLs', () => {
  it('accepts https URLs on the public repository and the documentation host', () => {
    expect(referenceErrors('See https://github.com/Delo-Run/delo/issues/12 and https://github.com/Delo-Run/delo.', context)).toEqual([])
    expect(referenceErrors('[guide](https://docs.delorun.com/guide/trust)', context)).toEqual([])
    expect(urlProblem('https://github.com/Delo-Run/delo/blob/v5/delo/docs/contracts/README.md#c16')).toBeUndefined()
  })

  it('refuses plain http, another repository, a look-alike repository, credentials and a port', () => {
    expect(urlProblem('http://github.com/Delo-Run/delo')).toBe('must be an https URL without credentials or a port')
    expect(urlProblem('https://github.com/deepseek-ai/deepseek-harness')).toBe('must point into github.com/Delo-Run/delo')
    expect(urlProblem('https://github.com/Delo-Run/delo-other/issues/1')).toBe('must point into github.com/Delo-Run/delo')
    expect(urlProblem('https://user@docs.delorun.com/')).toBe('must be an https URL without credentials or a port')
    expect(urlProblem('https://docs.delorun.com:8443/')).toBe('must be an https URL without credentials or a port')
    expect(urlProblem('https://example.com/page')).toBe('must be on github.com/Delo-Run/delo or docs.delorun.com')
  })
})

describe('links', () => {
  it('accepts a link to a tracked path, with or without a fragment', () => {
    expect(referenceErrors('[contracts](delo/docs/contracts/README.md) and [c16](delo/docs/contracts/README.md#c16)', context)).toEqual([])
  })

  it('refuses an untracked path, a path that leaves the tree, an anchor, a root-relative path and a mail link', () => {
    expect(referenceErrors('[x](delo/docs/contracts/missing.md)', context)).toEqual([
      'link "delo/docs/contracts/missing.md" is not a tracked file or directory',
    ])
    expect(referenceErrors('[x](../outside.md)', context)).toEqual(['link "../outside.md" leaves the repository'])
    expect(referenceErrors('[x](#section)', context)).toEqual([
      'link "#section" is an in-page anchor; an issue links a repository path or an https URL',
    ])
    expect(referenceErrors('[x](/AGENTS.md)', context)).toEqual(['link "/AGENTS.md" is not a repository path'])
    expect(referenceErrors('[x](mailto:someone@example.com)', context)).toEqual([
      'link "mailto:someone@example.com" must be an https URL or a repository path',
    ])
  })

  it('checks reference definitions and href or src attributes too', () => {
    expect(referenceErrors('[ref]: delo/docs/contracts/missing.md', context)).toEqual([
      'link "delo/docs/contracts/missing.md" is not a tracked file or directory',
    ])
    expect(referenceErrors('<a href="delo/docs/contracts/missing.md">x</a>', context)).toEqual([
      'link "delo/docs/contracts/missing.md" is not a tracked file or directory',
    ])
  })
})

describe('backticked paths', () => {
  it('accepts a tracked file, a tracked directory, a glob under a tracked directory and a path with a trailing comma', () => {
    expect(referenceErrors('`delo/apps/tools/src/issues/brief.ts`', context)).toEqual([])
    expect(referenceErrors('`delo/apps/tools/src/issues/`', context)).toEqual([])
    expect(referenceErrors('`delo/apps/tools/src/issues/*.ts`', context)).toEqual([])
    expect(referenceErrors('`delo/apps/tools/src/issues/brief.ts,`', context)).toEqual([])
    expect(referenceErrors('`./AGENTS.md`', context)).toEqual([])
  })

  it('refuses a path the tree does not track, including a new file and a glob under an untracked directory', () => {
    expect(referenceErrors('`delo/apps/tools/src/issues/new-file.ts`', context)).toEqual([
      '"delo/apps/tools/src/issues/new-file.ts" is not a tracked file or directory',
    ])
    expect(referenceErrors('`delo/apps/new/*.ts`', context)).toEqual([
      '"delo/apps/new/*.ts" is not a tracked file or directory',
    ])
  })

  it('refuses a private plan path, tracked or not, in code and in plain text', () => {
    expect(referenceErrors('`delo/docs/plans/private-plan.md`', context)).toEqual([
      'names delo/docs/plans, a private plan page that no brief links',
      '"delo/docs/plans/private-plan.md" names delo/docs/plans, a private plan page',
    ])
    expect(referenceErrors('See delo/docs/plans/next.md for the plan.', context)).toEqual([
      'names delo/docs/plans, a private plan page that no brief links',
    ])
    expect(referenceErrors('`delo/docs/plans/*.md`', context)).toEqual([
      'names delo/docs/plans, a private plan page that no brief links',
      '"delo/docs/plans/*.md" names delo/docs/plans, a private plan page',
    ])
  })

  it('reads the paths inside a command and inside a fenced block', () => {
    expect(referenceErrors('`node_modules/.bin/tsx delo/apps/tools/src/issues/brief.ts --dry-run`', context)).toEqual([])
    expect(referenceErrors('`node_modules/.bin/tsx delo/apps/tools/src/issues/missing.ts`', context)).toEqual([
      '"delo/apps/tools/src/issues/missing.ts" is not a tracked file or directory',
    ])
    expect(referenceErrors('```sh\ntsx delo/apps/tools/src/issues/missing.ts\n```', context)).toEqual([
      '"delo/apps/tools/src/issues/missing.ts" is not a tracked file or directory',
    ])
  })

  it('does not treat branch names, commands, labels, scoped package names and identifiers as paths', () => {
    expect(referenceErrors('`node_modules/.bin/tsx`', context)).toEqual([])
    expect(referenceErrors('`origin/v5` and `wave0/issues` and `kind/feature` and `area/tools`', context)).toEqual([])
    expect(referenceErrors('`pnpm --filter @delo/tools check` and `@delo/tools/src/x.ts`', context)).toEqual([])
    expect(referenceErrors('`ctx.effect()` and `Branded<B>`', context)).toEqual([])
  })
})

describe('machine paths', () => {
  it('refuses an absolute or home path in code and a home path in plain text', () => {
    expect(referenceErrors('`/home/owner/worktree`', context)).toEqual([
      '"/home/owner/worktree" is an absolute or home path; a brief names repository paths only',
    ])
    expect(referenceErrors('Worktree /home/owner/worktree/issues here.', context)).toEqual([
      '"/home/owner/worktree/issues" is a machine or home path; a brief names repository paths only',
    ])
    expect(referenceErrors('Config in ~/.config/delo/inference.env.', context)).toEqual([
      '"~/.config/delo/inference.env." is a machine or home path; a brief names repository paths only',
    ])
    expect(referenceErrors('Profile C:\\Users\\owner\\delo.', context)).toEqual([
      '"C:\\Users\\owner\\delo." is a machine or home path; a brief names repository paths only',
    ])
  })

  it('leaves plain slash-separated words alone', () => {
    expect(referenceErrors('Use and/or here, and v5/main as a label.', context)).toEqual([])
  })
})
