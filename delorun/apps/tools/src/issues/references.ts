/**
 * The references a work brief may carry into a GitHub issue, and how a rendered brief links them. The issue lives in the
 * public repository's tracker, so every reference names something that repository holds:
 *
 * - a link is an `https://` URL on github.com/Delo-Run/delo or docs.delorun.com, or a repository-relative path that the
 *   tree tracks;
 * - a backticked token is a repository path when its first segment is a top-level directory of the tree; it must then
 *   name a tracked file or directory, or the directory of a glob. The `You own` field may also name a new file or
 *   directory, when its nearest existing parent directory is tracked;
 * - no text names `delorun/docs/plans/`, the private plan directory, and no text names a machine path, such as a home
 *   directory.
 *
 * Other tokens, such as branch names, commands and identifiers, are not paths and pass. A rendered brief links each
 * tracked path it names to its place on the `v5` branch of the public repository.
 *
 * @module @delorun/tools/issues/references
 */

/** The URL path of the GitHub repository a brief may link into. */
export const GITHUB_REPOSITORY_PATH = '/Delo-Run/delo'

/** The documentation host a brief may link into. */
export const DOCS_HOST = 'docs.delorun.com'

/** The branch whose files a rendered brief links to. */
export const LINK_BRANCH = 'v5'

/** The private plan directory; no brief names it anywhere. */
const PRIVATE_PLANS = 'delorun/docs/plans'

/** The repository paths that references resolve against. */
export interface ReferenceContext {
  /** The tracked files, with `/` separators and no leading `./`. */
  readonly tracked: ReadonlySet<string>
  /** Every directory that holds a tracked file, without a trailing `/`. */
  readonly directories: ReadonlySet<string>
  /** The top-level directories; a token whose first segment is not one of them is not a repository path. */
  readonly topLevel: ReadonlySet<string>
  /** Whether a repository-relative directory exists in the working tree, whether or not it is tracked. */
  readonly isWorkingTreeDirectory: (directory: string) => boolean
}

/** The options of {@link referenceErrors}. */
export interface ReferenceOptions {
  /**
   * True for the `You own` field, which may name a file or directory that the tree does not track yet. Such a path is
   * allowed when its nearest existing parent directory is tracked.
   */
  readonly ownedPaths?: boolean
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

/** A fenced code block. The capture keeps each block at an odd index when the text is split on it. */
const FENCE_BLOCK = /^(`{3,}[^\n]*\n[\s\S]*?^`{3,}[ \t]*$)/mu
const REFERENCE_DEFINITION_LINE = /^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?)(\S+?)(>?)(?=\s|$)/gmu
const ATTRIBUTE_TARGET_PART = /(\b(?:href|src)\s*=\s*["'])([^"'\s]+)(["'])/giu
const LINK_OR_CODE = /(\[[^\]\n]*\]\([^)\n]*\))|(`[^`\n]+`)/gu
const LINK_TARGET_PART = /\]\((\s*<?)([^)\s>]+)/u

/**
 * Build the reference context from the repository's tracked paths.
 * @param tracked - the tracked paths, as `git ls-files` lists them.
 * @param isWorkingTreeDirectory - whether a repository-relative directory exists in the working tree.
 * @returns the files, their directories, the top-level directories and the working-tree test.
 */
export function referenceContext(
  tracked: readonly string[],
  isWorkingTreeDirectory: (directory: string) => boolean,
): ReferenceContext {
  const directories = new Set<string>()
  const topLevel = new Set<string>()
  for (const path of tracked) {
    const segments = path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'))
    }
    if (segments.length > 1) topLevel.add(segments[0] ?? '')
  }
  return { tracked: new Set(tracked), directories, topLevel, isWorkingTreeDirectory }
}

/**
 * Remove the leading `./` segments of a path.
 * @param path - a repository-relative path as written.
 * @returns the path without them.
 */
function normalizePath(path: string): string {
  return path.replace(/^(?:\.\/)+/u, '')
}

/**
 * The directory that holds a path.
 * @param path - a repository-relative path with `/` separators.
 * @returns the path before its last `/`, or the empty string for a top-level name.
 */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/**
 * Whether the tree tracks a path as a file or as a directory.
 * @param path - a repository-relative path without a trailing `/`.
 * @param context - the tree's files and directories.
 * @returns true when the path is tracked.
 */
function isTracked(path: string, context: ReferenceContext): boolean {
  return context.tracked.has(path) || context.directories.has(path)
}

/**
 * Whether a path the tree does not track has a tracked nearest existing parent. The walk checks the ancestors from the
 * nearest one: a tracked directory accepts the path, and a directory that exists in the working tree without tracked
 * files refuses it. Ancestors that do not exist are skipped.
 * @param path - a repository-relative path without a trailing `/`.
 * @param context - the tree's files and directories.
 * @returns true when the nearest existing parent is tracked.
 */
function newPathHasTrackedParent(path: string, context: ReferenceContext): boolean {
  for (let directory = parentOf(path); directory !== ''; directory = parentOf(directory)) {
    if (context.directories.has(directory)) return true
    if (context.isWorkingTreeDirectory(directory)) return false
  }
  return false
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
 * @param ownedPaths - whether the path is in the `You own` field, which allows a new path under a tracked directory.
 * @returns the problem, or undefined when the path is tracked, or is a glob whose directory passes.
 */
function pathProblem(path: string, context: ReferenceContext, ownedPaths: boolean): string | undefined {
  if (path.startsWith('/') || path.startsWith('~')) return 'is not a repository path'
  if (path.split('/').includes('..')) return 'leaves the repository'
  const wildcard = path.search(/[*?]/u)
  let target = path.replace(/\/+$/u, '')
  if (wildcard !== -1) {
    // A glob names the tree through the directory before its first wildcard segment.
    const literal = path.slice(0, wildcard)
    target = literal.slice(0, literal.lastIndexOf('/') + 1).replace(/\/+$/u, '')
  }
  if (target === '') return undefined
  if (target === PRIVATE_PLANS || target.startsWith(`${PRIVATE_PLANS}/`)) return `names ${PRIVATE_PLANS}, a private plan page`
  if (isTracked(target, context)) return undefined
  if (!ownedPaths) return 'is not a tracked file or directory'
  if (context.isWorkingTreeDirectory(target)) return 'exists in the working tree but holds no tracked file'
  return newPathHasTrackedParent(target, context) ? undefined : 'is new, and no tracked directory is its nearest existing parent'
}

/**
 * Why a link target is not a public reference. Links are never new paths: a link must resolve in the tree.
 * @param target - the target as written after the link's `]` or in its definition.
 * @param context - the tree's files and directories.
 * @returns the problem, or undefined when the target is an https URL or a tracked repository path.
 */
function linkProblem(target: string, context: ReferenceContext): string | undefined {
  if (target.includes('://')) return undefined
  if (SCHEME_WITHOUT_AUTHORITY.test(target)) return 'must be an https URL or a repository path'
  if (target.startsWith('#')) return 'is an in-page anchor; an issue links a repository path or an https URL'
  const path = normalizePath(target.split(/[?#]/u)[0] ?? '')
  return path === '' ? 'names nothing' : pathProblem(path, context, false)
}

/**
 * Why a whitespace-delimited token of a code span or fenced block is a repository path that does not pass.
 * @param token - one token of the code.
 * @param context - the tree's files and directories.
 * @param ownedPaths - whether the code is in the `You own` field.
 * @returns one message per problem; empty when the token is not a path or the path passes.
 */
function tokenProblems(token: string, context: ReferenceContext, ownedPaths: boolean): string[] {
  const path = normalizePath(token.replace(/,+$/u, ''))
  if (path === '' || path.includes('://')) return []
  if (ABSOLUTE_TOKEN.test(path)) return [`"${path}" is an absolute or home path; a brief names repository paths only`]
  if (!TOKEN_CHARACTERS.test(path) || !path.includes('/') || path.startsWith('@')) return []
  if (!ownedPaths && !context.topLevel.has(path.split('/')[0] ?? '')) return []
  const problem = pathProblem(path, context, ownedPaths)
  return problem === undefined ? [] : [`"${path}" ${problem}`]
}

/**
 * The problems with the references in one piece of brief text.
 * @param text - Markdown text from one field, the title or a milestone.
 * @param context - the tree's files and directories.
 * @param options - whether the text is the `You own` field, which may name new paths.
 * @returns one message per problem, with the offending reference quoted; empty when every reference passes.
 */
export function referenceErrors(text: string, context: ReferenceContext, options: ReferenceOptions = {}): string[] {
  const ownedPaths = options.ownedPaths === true
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
    for (const token of code.split(/\s+/u)) problems.push(...tokenProblems(token, context, ownedPaths))
  }
  // Code has its own rule above, so the prose left after removing code is checked for home paths.
  const prose = text.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ')
  for (const match of prose.matchAll(MACHINE_PATH)) {
    problems.push(`"${(match[0] ?? '').trim()}" is a machine or home path; a brief names repository paths only`)
  }
  return [...new Set(problems)]
}

/**
 * The address of a tracked path on GitHub: a file's `blob` or a directory's `tree`, on the {@link LINK_BRANCH} branch.
 * @param path - a tracked repository path without a trailing `/`.
 * @param context - the tree's files and directories, which tell a file from a directory.
 * @returns the `https://github.com` URL.
 */
function repositoryUrl(path: string, context: ReferenceContext): string {
  const view = context.directories.has(path) ? 'tree' : 'blob'
  const segments = path.split('/').map(segment => encodeURIComponent(segment))
  return `https://github.com${GITHUB_REPOSITORY_PATH}/${view}/${LINK_BRANCH}/${segments.join('/')}`
}

/**
 * The target of a link with its tracked path replaced by the GitHub address. Targets that are URLs, anchors, or paths the
 * tree does not track are returned unchanged.
 * @param target - the target as written, which may carry a `#fragment` or a `?query`.
 * @param context - the tree's files and directories.
 * @returns the target to write.
 */
function linkedTarget(target: string, context: ReferenceContext): string {
  if (target.includes('://') || SCHEME_WITHOUT_AUTHORITY.test(target) || target.startsWith('#')) return target
  const cut = target.search(/[?#]/u)
  const path = normalizePath(cut === -1 ? target : target.slice(0, cut)).replace(/\/+$/u, '')
  if (!isTracked(path, context)) return target
  return `${repositoryUrl(path, context)}${cut === -1 ? '' : target.slice(cut)}`
}

/**
 * A code span holding one tracked path, as a link whose text is the code span.
 * @param content - the text between the backticks.
 * @param context - the tree's files and directories.
 * @returns the link, or undefined when the content is not one tracked path.
 */
function linkedCode(content: string, context: ReferenceContext): string | undefined {
  if (content === '' || /\s/u.test(content)) return undefined
  const path = normalizePath(content).replace(/\/+$/u, '')
  return isTracked(path, context) ? `[\`${content}\`](${repositoryUrl(path, context)})` : undefined
}

/**
 * Link the references in one part of a field that holds no fenced code block.
 * @param part - Markdown text without fenced blocks.
 * @param context - the tree's files and directories.
 * @returns the part with its tracked references linked.
 */
function linkPart(part: string, context: ReferenceContext): string {
  return part
    .replace(REFERENCE_DEFINITION_LINE, (_line: string, lead: string, target: string, close: string) => `${lead}${linkedTarget(target, context)}${close}`)
    .replace(ATTRIBUTE_TARGET_PART, (_whole: string, lead: string, target: string, quote: string) => `${lead}${linkedTarget(target, context)}${quote}`)
    .replace(LINK_OR_CODE, (match: string, link: string | undefined, code: string | undefined) => {
      if (link !== undefined) {
        return link.replace(LINK_TARGET_PART, (_part: string, open: string, target: string) => `](${open}${linkedTarget(target, context)}`)
      }
      if (code === undefined) return match
      return linkedCode(code.slice(1, -1), context) ?? match
    })
}

/**
 * The text of a brief field with its repository references linked to the {@link LINK_BRANCH} branch: each tracked path
 * in a code span of its own, each link target that names a tracked path, and each reference definition and `href` or
 * `src` attribute that does. Fenced code blocks, code spans that hold a command, and any other text stay as written.
 * @param text - Markdown text from one field.
 * @param context - the tree's files and directories.
 * @returns the text with its tracked references linked.
 */
export function linkReferences(text: string, context: ReferenceContext): string {
  return text
    .split(FENCE_BLOCK)
    .map((part, index) => (index % 2 === 1 ? part : linkPart(part, context)))
    .join('')
}
