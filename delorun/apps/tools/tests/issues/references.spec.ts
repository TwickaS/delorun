import { describe, expect, it } from 'vitest'
import { LINK_BRANCH, linkReferences, referenceContext, referenceErrors, urlProblem } from '../../src/issues/references.ts'

/** The directories that exist in the working tree without tracked files. */
const UNTRACKED_DIRECTORIES: ReadonlySet<string> = new Set(['scratch'])

const context = referenceContext([
  'AGENTS.md',
  'delorun/docs/contracts/README.md',
  'delorun/apps/tools/src/issues/brief.ts',
  'delorun/apps/tools/src/checks/gates/doc-times.ts',
  'delorun/docs/plans/private-plan.md',
  'packages/example/index.ts',
], directory => UNTRACKED_DIRECTORIES.has(directory))

const OWNED = { ownedPaths: true }

describe('public URLs', () => {
  it('accepts https URLs on the public repository and the documentation host', () => {
    expect(referenceErrors('See https://github.com/twickas/delorun/issues/12 and https://github.com/twickas/delorun.', context)).toEqual([])
    expect(referenceErrors('[guide](https://docs.delorun.com/guide/safety-and-updates/trust)', context)).toEqual([])
    expect(urlProblem('https://github.com/twickas/delorun/blob/main/delorun/docs/contracts/README.md#c16')).toBeUndefined()
  })

  it('refuses plain http, another repository, a look-alike repository, credentials and a port', () => {
    expect(urlProblem('http://github.com/twickas/delorun')).toBe('must be an https URL without credentials or a port')
    expect(urlProblem('https://github.com/deepseek-ai/deepseek-harness')).toBe('must point into github.com/twickas/delorun')
    expect(urlProblem('https://github.com/twickas/delo-other/issues/1')).toBe('must point into github.com/twickas/delorun')
    expect(urlProblem('https://user@docs.delorun.com/')).toBe('must be an https URL without credentials or a port')
    expect(urlProblem('https://docs.delorun.com:8443/')).toBe('must be an https URL without credentials or a port')
    expect(urlProblem('https://example.com/page')).toBe('must be on github.com/twickas/delorun or docs.delorun.com')
  })
})

describe('links', () => {
  it('accepts a link to a tracked path, with or without a fragment', () => {
    expect(referenceErrors('[contracts](delorun/docs/contracts/README.md) and [c16](delorun/docs/contracts/README.md#c16)', context)).toEqual([])
  })

  it('refuses an untracked path, a path that leaves the tree, an anchor, a root-relative path and a mail link', () => {
    expect(referenceErrors('[x](delorun/docs/contracts/missing.md)', context)).toEqual([
      'link "delorun/docs/contracts/missing.md" is not a tracked file or directory',
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
    expect(referenceErrors('[ref]: delorun/docs/contracts/missing.md', context)).toEqual([
      'link "delorun/docs/contracts/missing.md" is not a tracked file or directory',
    ])
    expect(referenceErrors('<a href="delorun/docs/contracts/missing.md">x</a>', context)).toEqual([
      'link "delorun/docs/contracts/missing.md" is not a tracked file or directory',
    ])
  })
})

describe('backticked paths', () => {
  it('accepts a tracked file, a tracked directory, a glob under a tracked directory and a path with a trailing comma', () => {
    expect(referenceErrors('`delorun/apps/tools/src/issues/brief.ts`', context)).toEqual([])
    expect(referenceErrors('`delorun/apps/tools/src/issues/`', context)).toEqual([])
    expect(referenceErrors('`delorun/apps/tools/src/issues/*.ts`', context)).toEqual([])
    expect(referenceErrors('`delorun/apps/tools/src/issues/brief.ts,`', context)).toEqual([])
    expect(referenceErrors('`./AGENTS.md`', context)).toEqual([])
  })

  it('refuses a path the tree does not track, including a new file and a glob under an untracked directory', () => {
    expect(referenceErrors('`delorun/apps/tools/src/issues/new-file.ts`', context)).toEqual([
      '"delorun/apps/tools/src/issues/new-file.ts" is not a tracked file or directory',
    ])
    expect(referenceErrors('`delorun/apps/new/*.ts`', context)).toEqual([
      '"delorun/apps/new/*.ts" is not a tracked file or directory',
    ])
  })

  it('refuses a private plan path, tracked or not, in code and in plain text', () => {
    expect(referenceErrors('`delorun/docs/plans/private-plan.md`', context)).toEqual([
      'names delorun/docs/plans, a private plan page that no brief links',
      '"delorun/docs/plans/private-plan.md" names delorun/docs/plans, a private plan page',
    ])
    expect(referenceErrors('See delorun/docs/plans/next.md for the plan.', context)).toEqual([
      'names delorun/docs/plans, a private plan page that no brief links',
    ])
    expect(referenceErrors('`delorun/docs/plans/*.md`', context)).toEqual([
      'names delorun/docs/plans, a private plan page that no brief links',
      '"delorun/docs/plans/*.md" names delorun/docs/plans, a private plan page',
    ])
  })

  it('reads the paths inside a command and inside a fenced block', () => {
    expect(referenceErrors('`node_modules/.bin/tsx delorun/apps/tools/src/issues/brief.ts --dry-run`', context)).toEqual([])
    expect(referenceErrors('`node_modules/.bin/tsx delorun/apps/tools/src/issues/missing.ts`', context)).toEqual([
      '"delorun/apps/tools/src/issues/missing.ts" is not a tracked file or directory',
    ])
    expect(referenceErrors('```sh\ntsx delorun/apps/tools/src/issues/missing.ts\n```', context)).toEqual([
      '"delorun/apps/tools/src/issues/missing.ts" is not a tracked file or directory',
    ])
  })

  it('does not treat branch names, commands, labels, scoped package names and identifiers as paths', () => {
    expect(referenceErrors('`node_modules/.bin/tsx`', context)).toEqual([])
    expect(referenceErrors('`origin/main` and `batch0/issues` and `kind/feature` and `area/tools`', context)).toEqual([])
    expect(referenceErrors('`pnpm --filter @delorun/tools check` and `@delorun/tools/src/x.ts`', context)).toEqual([])
    expect(referenceErrors('`ctx.effect()` and `Branded<B>`', context)).toEqual([])
  })
})

describe('new paths in the owned-paths field', () => {
  it('accepts a new file or directory whose nearest existing parent directory is tracked', () => {
    expect(referenceErrors('`delorun/apps/tools/src/issues/new-module.ts`', context, OWNED)).toEqual([])
    expect(referenceErrors('`delorun/apps/tools/src/issues/next/deeper.ts`', context, OWNED)).toEqual([])
    expect(referenceErrors('`packages/new-package/`', context, OWNED)).toEqual([])
  })

  it('refuses a new path under a parent directory that exists in the working tree without tracked files', () => {
    expect(referenceErrors('`scratch/notes/a.ts`', context, OWNED)).toEqual([
      '"scratch/notes/a.ts" is new, and no tracked directory is its nearest existing parent',
    ])
    expect(referenceErrors('`scratch/`', context, OWNED)).toEqual([
      '"scratch/" exists in the working tree but holds no tracked file',
    ])
  })

  it('refuses a new path under a new top-level directory', () => {
    expect(referenceErrors('`newroot/a.ts`', context, OWNED)).toEqual([
      '"newroot/a.ts" is new, and no tracked directory is its nearest existing parent',
    ])
  })

  it('keeps refusing a new path in every other field', () => {
    expect(referenceErrors('`delorun/apps/tools/src/issues/new-module.ts`', context)).toEqual([
      '"delorun/apps/tools/src/issues/new-module.ts" is not a tracked file or directory',
    ])
  })

  it('keeps refusing the private plan directory, absolute paths and untracked link targets in the owned-paths field', () => {
    expect(referenceErrors('`delorun/docs/plans/x.md`', context, OWNED)).toEqual([
      'names delorun/docs/plans, a private plan page that no brief links',
      '"delorun/docs/plans/x.md" names delorun/docs/plans, a private plan page',
    ])
    expect(referenceErrors('`/home/owner/x.ts`', context, OWNED)).toEqual([
      '"/home/owner/x.ts" is an absolute or home path; a brief names repository paths only',
    ])
    expect(referenceErrors('[x](delorun/apps/tools/src/issues/new-module.ts)', context, OWNED)).toEqual([
      'link "delorun/apps/tools/src/issues/new-module.ts" is not a tracked file or directory',
    ])
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
    expect(referenceErrors('Config in ~/.config/delorun/inference.env.', context)).toEqual([
      '"~/.config/delorun/inference.env." is a machine or home path; a brief names repository paths only',
    ])
    expect(referenceErrors('Profile C:\\Users\\owner\\delorun.', context)).toEqual([
      '"C:\\Users\\owner\\delorun." is a machine or home path; a brief names repository paths only',
    ])
  })

  it('leaves plain slash-separated words alone', () => {
    expect(referenceErrors('Use and/or here, and left/right as a label.', context)).toEqual([])
  })
})

describe('linking a rendered brief', () => {
  it('links a tracked file to its blob and a tracked directory to its tree on the main branch', () => {
    expect(LINK_BRANCH).toBe('main')
    expect(linkReferences('See `AGENTS.md` and `delorun/apps/tools/src/issues/`.', context)).toBe(
      'See [`AGENTS.md`](https://github.com/twickas/delorun/blob/main/AGENTS.md) and [`delorun/apps/tools/src/issues/`](https://github.com/twickas/delorun/tree/main/delorun/apps/tools/src/issues).',
    )
  })

  it('links a code span of a tracked path with a leading ./ to the path without it', () => {
    expect(linkReferences('`./AGENTS.md`', context)).toBe('[`./AGENTS.md`](https://github.com/twickas/delorun/blob/main/AGENTS.md)')
  })

  it('rewrites a relative link target and keeps its fragment, and does the same for reference definitions and attributes', () => {
    expect(linkReferences('[brief](delorun/apps/tools/src/issues/brief.ts#L1)', context)).toBe(
      '[brief](https://github.com/twickas/delorun/blob/main/delorun/apps/tools/src/issues/brief.ts#L1)',
    )
    expect(linkReferences('[ref]: AGENTS.md', context)).toBe('[ref]: https://github.com/twickas/delorun/blob/main/AGENTS.md')
    expect(linkReferences('<img src="delorun/docs/contracts/">', context)).toBe(
      '<img src="https://github.com/twickas/delorun/tree/main/delorun/docs/contracts">',
    )
  })

  it('rewrites the target of a link whose label holds a code span, without wrapping the label again', () => {
    expect(linkReferences('[`AGENTS.md`](AGENTS.md)', context)).toBe(
      '[`AGENTS.md`](https://github.com/twickas/delorun/blob/main/AGENTS.md)',
    )
  })

  it('leaves commands, new and untracked paths, URLs, anchors, absolute paths and fenced blocks as written', () => {
    const text = [
      '`node_modules/.bin/tsx delorun/apps/tools/src/issues/brief.ts --dry-run`',
      '`delorun/apps/tools/src/issues/new-module.ts` and `scratch/notes/a.ts`',
      '[site](https://docs.delorun.com/guide) and [top](#top) and `/home/owner/x`',
      '```sh',
      'cat `AGENTS.md`',
      '```',
    ].join('\n')
    expect(linkReferences(text, context)).toBe(text)
  })
})
