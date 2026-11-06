/**
 * The references a work brief may carry into a GitHub issue. The issue lives in the public repository's tracker, so
 * every reference must name something that repository holds:
 *
 * - a link is an `https://` URL on github.com/Delo-Run/delo or docs.delorun.com, or a repository-relative path;
 * - a backticked token is a repository path when its first segment is a top-level directory of the tree, and then it
 *   must name a tracked file or directory, or the literal directory of a glob;
 * - no text names `delo/docs/plans/`, the private plan directory;
 * - no text names a machine path, such as a home directory.
 *
 * Other tokens, such as branch names, commands and identifiers, are not paths and pass.
 *
 * @module @delo/tools/issues/references
 */

/** The URL path of the GitHub repository a brief may link into. */
export const GITHUB_REPOSITORY_PATH = '/Delo-Run/delo'

/** The documentation host a brief may link into. */
export const DOCS_HOST = 'docs.delorun.com'

/** The private plan directory; no brief names it anywhere. */
const PRIVATE_PLANS = 'delo/docs/plans'

/** The repository paths that references resolve against. */
export interface ReferenceContext {
  /** The tracked files, with `/` separators and no leading `./`. */
  readonly tracked: ReadonlySet<string>
  /** Every directory that holds a tracked file, without a trailing `/`. */
  readonly directories: ReadonlySet<string>
  /** The top-level directories; a token whose first segment is not one of them is not a repository path. */
  readonly topLevel: ReadonlySet<string>
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()[\]`'"]+/giu
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u
const MARKDOWN_LINK_TARGET = /\]\(\s*<?([^)\s>]+)/gu
const REFERENCE_DEFINITION_TARGET = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?(\S+?)>?(?=\s|$)/gmu
const ATTRIBUTE_TARGET = /\b(?:href|src)\s*=\s*["']([^"'\s]+)["']/giu
const FENCED_CODE = /^`{3,}[^\n]*\n([\s\S]*?)^`{3,}[ \t]*$/gmu
const INLINE_CODE = /`([^`\n]+)`/gu
const MACHINE_PATH = /(?:^|[\s(<"'`])(?:\/home\/|\/Users\/|\/root\/|~\/|[A-Za-z]:\\)\S*/gu
const SCHEME_WITHOUT_AUTHORITY = /^[a-z][a-z0-9+.-]*:/iu
const TOKEN_CHARACTERS = /^[A-Za-z0-9._~%+\-/*?]+$/u
const ABSOLUTE_TOKEN = /^(?:\/|~\/)./u

/**
 * Build the reference context from the repository's tracked paths.
 * @param tracked - the tracked paths, as `git ls-files` lists them.
 * @returns the files, their directories and the top-level directories.
 */
export function referenceContext(tracked: readonly string[]): ReferenceContext {
  const directories = new Set<string>()
  const topLevel = new Set<string>()
  for (const path of tracked) {
    const segments = path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'))
    }
    if (segments.length > 1) topLevel.add(segments[0] ?? '')
  }
  return { tracked: new Set(tracked), directories, topLevel }
}

/**
 * Why a URL is not a public reference.
 * @param raw - the URL as written.
 * @returns the problem, or undefined for an https URL on the public repository or the documentation host.
 */
export function urlProblem(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'is not a valid URL'
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return 'must be an https URL without credentials or a port'
  }
  if (url.hostname === 'github.com') {
    const inRepository = url.pathname === GITHUB_REPOSITORY_PATH || url.pathname.startsWith(`${GITHUB_REPOSITORY_PATH}/`)
    return inRepository ? undefined : `must point into github.com${GITHUB_REPOSITORY_PATH}`
  }
  return url.hostname === DOCS_HOST ? undefined : `must be on github.com${GITHUB_REPOSITORY_PATH} or ${DOCS_HOST}`
}

/**
 * Why a repository-relative path does not name the tree.
 * @param path - the path with `/` separators, without a leading `./`.
 * @param context - the tree's files and directories.
 * @returns the problem, or undefined when the path is tracked, is a tracked directory, or is a glob whose literal
 * directory is tracked.
 */
function pathProblem(path: string, context: ReferenceContext): string | undefined {
  if (path.startsWith('/') || path.startsWith('~')) return 'is not a repository path'
  if (path.split('/').includes('..')) return 'leaves the repository'
  const wildcard = path.search(/[*?]/u)
  let target = path.replace(/\/+$/u, '')
  if (wildcard !== -1) {
    // A glob names the tree when its literal directory, the part before its last `/`, is tracked.
    const literal = path.slice(0, wildcard)
    target = literal.slice(0, literal.lastIndexOf('/') + 1).replace(/\/+$/u, '')
  }
  if (target === '') return undefined
  if (target === PRIVATE_PLANS || target.startsWith(`${PRIVATE_PLANS}/`)) return `names ${PRIVATE_PLANS}, a private plan page`
  return context.tracked.has(target) || context.directories.has(target) ? undefined : 'is not a tracked file or directory'
}

/**
 * Why a link target is not a public reference.
 * @param target - the target as written after the link's `]` or in its definition.
 * @param context - the tree's files and directories.
 * @returns the problem, or undefined when the target is an https URL or a valid repository path.
 */
function linkProblem(target: string, context: ReferenceContext): string | undefined {
  if (target.includes('://')) return undefined
  if (SCHEME_WITHOUT_AUTHORITY.test(target)) return 'must be an https URL or a repository path'
  if (target.startsWith('#')) return 'is an in-page anchor; an issue links a repository path or an https URL'
  const path = target.split(/[?#]/u)[0] ?? ''
  return path === '' ? 'names nothing' : pathProblem(path, context)
}

/**
 * Why a whitespace-delimited token from a code span or fenced block is a repository path that does not exist.
 * @param token - one token of the code.
 * @param context - the tree's files and directories.
 * @returns one message per problem; empty when the token is not a path or the path names the tree.
 */
function tokenProblems(token: string, context: ReferenceContext): string[] {
  const path = token.replace(/,+$/u, '').replace(/^(?:\.\/)+/u, '')
  if (path === '' || path.includes('://')) return []
  if (ABSOLUTE_TOKEN.test(path)) return [`"${path}" is an absolute or home path; a brief names repository paths only`]
  if (!TOKEN_CHARACTERS.test(path) || !path.includes('/') || path.startsWith('@')) return []
  if (!context.topLevel.has(path.split('/')[0] ?? '')) return []
  const problem = pathProblem(path, context)
  return problem === undefined ? [] : [`"${path}" ${problem}`]
}

/**
 * The problems with the references in one piece of brief text.
 * @param text - Markdown text from one field, the title or a milestone.
 * @param context - the tree's files and directories.
 * @returns one message per problem, with the offending reference quoted; empty when every reference is public.
 */
export function referenceErrors(text: string, context: ReferenceContext): string[] {
  const problems: string[] = []
  if (text.includes(PRIVATE_PLANS)) problems.push(`names ${PRIVATE_PLANS}, a private plan page that no brief links`)
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = (match[0] ?? '').replace(TRAILING_PUNCTUATION, '')
    const problem = urlProblem(url)
    if (problem !== undefined) problems.push(`link "${url}" ${problem}`)
  }
  for (const pattern of [MARKDOWN_LINK_TARGET, REFERENCE_DEFINITION_TARGET, ATTRIBUTE_TARGET]) {
    for (const match of text.matchAll(pattern)) {
      const target = match[1] ?? ''
      const problem = linkProblem(target, context)
      if (problem !== undefined) problems.push(`link "${target}" ${problem}`)
    }
  }
  const fenced = [...text.matchAll(FENCED_CODE)].map(match => match[1] ?? '')
  const inline = [...text.replace(FENCED_CODE, '').matchAll(INLINE_CODE)].map(match => match[1] ?? '')
  for (const code of [...fenced, ...inline]) {
    for (const token of code.split(/\s+/u)) problems.push(...tokenProblems(token, context))
  }
  // Code has its own rule above, so the prose left after removing code is checked for home paths.
  const prose = text.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ')
  for (const match of prose.matchAll(MACHINE_PATH)) {
    problems.push(`"${(match[0] ?? '').trim()}" is a machine or home path; a brief names repository paths only`)
  }
  return [...new Set(problems)]
}
