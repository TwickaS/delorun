/**
 * Shared execution plumbing for the `glob` / `grep` search tools: the
 * package-owned `SEARCH_*` error vocabulary, one spawn helper that runs the
 * PACKAGED ripgrep binary (`@vscode/ripgrep`) with a plain argv vector and
 * returns complete raw stdout, the best-effort formatted-result spill handoff,
 * and workdir-relative path display.
 *
 * Both tools execute as ordinary foreground spawns through `ctx.subprocess` —
 * never `ctx.shell`, never `ctx.shell.start()`, never a model-visible background
 * task. The ripgrep binary ships inside the npm package, so no system `rg`
 * install is required, and no shell layer exists between the argv vector and
 * ripgrep, so no shell quoting is involved. Raw `rg` stdout is an internal
 * transport detail: the tools request a per-run stdout capture budget from the
 * subprocess seam, parse only complete in-memory stdout within
 * `rawOutputMaxBytes`, and never read spill files. The model-facing recovery
 * artifact is the formatted result saved through `ctx.spillStore.saveText()`
 * ({@link trySaveFormattedResult}).
 *
 * @module @deepseek-ai/dsh-tool-fs-search/search-core
 */

import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ItemRetainer, TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { RetainedItems } from '@deepseek-ai/dsh-output-retention'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { spillReadGrants } from '@deepseek-ai/dsh-spill'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { canonicalPath, classifyRunnerFailure, pathWithin, protectedReadGuard, toolReadableOnly } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, RunnerFailureRule, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/**
 * Default cap on the complete raw `rg` stdout the tools will parse (the
 * `rawOutputMaxBytes` config), matching Claude Code's ripgrep raw buffer.
 */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000

/**
 * Default cooperative tool-call timeout budget in milliseconds (the `timeoutMs`
 * config), attached to both tool definitions for
 * `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce through `exec.signal`.
 */
export const SEARCH_TIMEOUT_MS = 30_000

/**
 * Default cap in bytes on the retained stderr tail of one search run — a
 * diagnostic excerpt only (the tool never reads a stderr spill path, and the
 * collect disposition requests none).
 */
export const SEARCH_STDERR_MAX_BYTES = 64 * 1024

/** Default terminate grace period for a search process (ms). */
export const SEARCH_GRACE_MS = 3_000

/**
 * Default cap in bytes on one search's serialized `presentationMeta` (the
 * `searchMetaMaxBytes` config). The inline match/path caps already bound the item
 * COUNT, but retained matches of a broad search (many long lines) can still
 * serialize to hundreds of kilobytes, and `meta` is persisted with the session
 * log and re-sent on every request. A deployment's final output budget
 * (`dsh-spill-policy`) only shrinks a result's `content`, never its `meta`, so the
 * projection owns this cap. 64 KiB holds the full default-capped result of a
 * typical search while bounding the pathological one.
 */
export const SEARCH_META_MAX_BYTES = 65_536

/**
 * Stable, machine-routable codes for search failures. Package-owned (not
 * `FsErrorCode`) because these tools are spawn-backed discovery, not `ctx.fs`
 * provider operations: `SEARCH_INVALID_PATTERN` — ripgrep rejected the regex or
 * glob; `SEARCH_FAILED` — the search could not run or its output could not be
 * parsed (a failed `rg` launch, inaccessible target, signal kill, malformed
 * `--json`); `SEARCH_RAW_OUTPUT_OVERFLOW` — raw `rg` output exceeded
 * `rawOutputMaxBytes` or stayed truncated after that requested stdout budget;
 * `SEARCH_ABORTED` — the cooperative tool timeout or caller cancellation cut
 * the search short; `SEARCH_SANDBOX_DENIED` — the search root lies under the
 * sandbox provider's protected home.
 */
export type SearchErrorCode =
  | 'SEARCH_INVALID_PATTERN'
  | 'SEARCH_FAILED'
  | 'SEARCH_RAW_OUTPUT_OVERFLOW'
  | 'SEARCH_ABORTED'
  | 'SEARCH_SANDBOX_DENIED'

/**
 * Typed search failure. Extends {@link HarnessError} so it carries a stable
 * {@link SearchErrorCode} and chains `cause`; the tool registry exposes
 * `{ name, code }` on `isError` results so retry/permission/UI layers can
 * branch without parsing messages.
 */
export class SearchError extends HarnessError {
  override readonly code: SearchErrorCode

  constructor(message: string, code: SearchErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** The completed acquisition of one `rg` run: complete stdout plus the resolved workdir. */
export interface RipgrepRun {
  /** Complete raw stdout retained by the subprocess seam within the requested cap. */
  stdout: string
  /** True when ripgrep exited 1: a successful search with zero results. */
  noMatches: boolean
  /** The resolved working directory the command ran in (the display-relativization base). */
  workdir: string
  /** Whether to keep one path as ripgrep printed it: false for a path under the sandbox provider's protected reads. */
  keep: (outputPath: string) => boolean
  /** One path as ripgrep printed it, respelled under the requested search path, as an unprotected search prints it. */
  display: (outputPath: string) => string
}

/** The search root of one `rg` run: the model's spelling, and the argv that searches a given root spelling. */
export interface RipgrepSearch {
  /** The requested search root, or `undefined` for the working directory. */
  path: string | undefined
  /**
   * Build the ripgrep arguments for one root spelling.
   * @param path - the root spelling ripgrep receives, or `undefined` to search its working directory.
   * @returns the ripgrep arguments, excluding the binary.
   */
  argv(path: string | undefined): readonly string[]
}

/**
 * The retained stderr tail as a diagnostic excerpt, with a truncation note when
 * the subprocess seam dropped bytes.
 */
function stderrExcerpt(stderrText: string, truncated: boolean): string {
  const text = stderrText.trim()
  if (text.length === 0) return ''
  return truncated ? `${text} [stderr truncated]` : text
}

/**
 * Classify a nonzero-exit `rg` run into the search error vocabulary. There is
 * no shell layer, so an exit 127 or shell "command not found" text cannot
 * occur — a launch failure rejects at spawn (see {@link runRipgrep}).
 */
function classifyRunFailure(toolName: string, exitCode: number, stderrText: string, stderrTruncated: boolean): SearchError {
  const stderr = stderrExcerpt(stderrText, stderrTruncated)
  if (/regex parse error|error parsing glob/i.test(stderr)) {
    return new SearchError(`${toolName} pattern rejected by ripgrep: ${stderr}`, 'SEARCH_INVALID_PATTERN')
  }
  return new SearchError(`${toolName} search failed (exit ${exitCode})${stderr.length > 0 ? `: ${stderr}` : ''}`, 'SEARCH_FAILED')
}

/**
 * Acquire the COMPLETE raw stdout of a finished run, enforcing
 * `rawOutputMaxBytes` on the in-memory transport. A truncated result means the
 * subprocess seam could not retain complete stdout within the requested
 * budget, so the tool fails clearly instead of parsing a silently-partial
 * stream.
 */
function completeStdout(toolName: string, stdout: SubprocessOutputRead, rawOutputMaxBytes: number): string {
  const narrow = 'narrow pattern, path, or include and retry'
  if (!stdout.lossy) {
    const inlineBytes = Buffer.byteLength(stdout.text, 'utf8')
    if (inlineBytes > rawOutputMaxBytes) {
      throw new SearchError(
        `${toolName} produced ${inlineBytes} bytes of raw output, over the ${rawOutputMaxBytes}-byte cap; ${narrow}`,
        'SEARCH_RAW_OUTPUT_OVERFLOW',
      )
    }
    return stdout.text
  }
  throw new SearchError(
    `${toolName} produced more raw output than the subprocess seam retained within the ${rawOutputMaxBytes}-byte cap; ${narrow}`,
    'SEARCH_RAW_OUTPUT_OVERFLOW',
  )
}

let rgPathPromise: Promise<string> | undefined

/**
 * The packaged ripgrep binary path, resolved lazily once per process.
 *
 * A single-file runtime uses the executable's `-rg` sidecar because a native
 * helper cannot be spawned from pkg's virtual filesystem. Node-mode builds
 * fall back to the platform package selected by `@vscode/ripgrep`. Resolving
 * at the call boundary keeps a missing or corrupt binary at the first search
 * call as `SEARCH_FAILED`, rather than failing the Loader composition.
 *
 * @returns the packaged binary's absolute path; the memoized promise rejects
 *   when the platform package cannot be resolved.
 */
export function resolveRgPath(): Promise<string> {
  rgPathPromise ??= Promise.resolve().then(async () => {
    const executable = parse(process.execPath)
    const executableSidecar = process.platform === 'win32'
      ? join(executable.dir, `${executable.name}-rg.exe`)
      : `${process.execPath}-rg`
    if ('pkg' in process && existsSync(executableSidecar)) return executableSidecar
    const dependency = (await import('@vscode/ripgrep')).rgPath
    return process.versions.electron === undefined
      ? dependency
      : dependency.replace(/\.asar(?=[\\/])/u, '.asar.unpacked')
  })
  return rgPathPromise
}

/**
 * The canonical spelling of an absolute path that may not exist yet: the deepest existing ancestor resolved through
 * its links, with the missing rest appended, as `ctx.fs.resolve` spells a missing target. A root under a link to the
 * protected home is therefore checked against the home even before the directory below the link exists.
 * @param path - an absolute path.
 * @returns the canonical path.
 */
function resolvedPath(path: string): string {
  const missing: string[] = []
  let ancestor = path
  for (;;) {
    const canonical = canonicalPath(ancestor)
    // canonicalPath returns its argument unchanged only when the path cannot be resolved.
    if (canonical !== ancestor || existsSync(ancestor)) return join(canonical, ...missing.reverse())
    const parent = dirname(ancestor)
    if (parent === ancestor) return path
    missing.push(basename(ancestor))
    ancestor = parent
  }
}

/** How one `rg` run treats the sandbox provider's protected reads, planned before ripgrep starts. */
interface SearchTarget {
  /** The directory ripgrep runs in. */
  cwd: string
  /** The root spelling ripgrep receives, or `undefined` to search {@link cwd}. */
  path: string | undefined
  /** Wrap ripgrep's argv under the provider's `read-only` confinement, or `undefined` to run it unconfined. */
  confine: ((argv: readonly string[], signal: AbortSignal) => Promise<ConfinedArgv>) | undefined
  /** The check for one canonical path; always false when nothing is protected. */
  refused: (path: string) => boolean
  /** Whether to report one output path. */
  keep: (outputPath: string) => boolean
  /** One output path respelled under the requested root. */
  display: (outputPath: string) => string
  /** Refuse the finished search when its root no longer resolves to the path ripgrep searched. */
  verify: () => void
}

/** The read-only confinement for a search run on behalf of `exec`: the session's workspace root, or the workdir. */
function searchPolicy(ctx: Context, exec: ToolExecution, workdir: string): SandboxPolicy {
  const resolved = ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  return {
    mode: 'read-only',
    workspaceRoot: resolved?.workspaceRoot ?? workdir,
    ...resolved?.sessionId === undefined ? {} : { sessionId: resolved.sessionId },
  }
}

/**
 * Plan the sandbox provider's protected-read check for one search, before ripgrep starts. It applies whenever the
 * provider reports protected reads, as the `read` tool's check does, so no tool row's config can leave it out; a
 * provider that protects no home, such as upstream's unconfigured local provider, and a session under
 * `danger-full-access` make it a pass-through.
 *
 * Under protection, the search root is resolved to its canonical path first and refused when that path is protected.
 * Ripgrep then receives the canonical path rather than the model's spelling, or runs in the canonical directory when
 * no path was given, and runs confined by the provider under `read-only`, so the kernel keeps the protected home
 * unreadable at every depth even when a link in the workspace is replaced while the search runs. Each output path,
 * which ripgrep prints beneath the root without following links below it, is checked as a canonical path, and the
 * search is refused when its root resolves differently afterwards. On a runner that does not confine reads, such as
 * the Windows ACL runner, the canonical root and the output check remain and a link replaced during the search and
 * restored before it ends is not detected. A root under one of the provider's tool-readable entries, such as the spill
 * directory, runs unconfined over its canonical path, since the kernel would hide it from a confined run and confined
 * commands cannot write beneath the protected home.
 */
function searchTarget(ctx: Context, exec: ToolExecution, toolName: string, workdir: string, searchPath: string | undefined): SearchTarget {
  const sandbox = ctx.get('sandbox')
  const reads = sandbox?.protectedReads
  const mode = reads === undefined
    ? 'danger-full-access'
    : ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session }).mode ?? 'read-only'
  const refused = protectedReadGuard(reads, mode, spillReadGrants(ctx, exec.agent?.session.header))
  if (sandbox === undefined || reads === undefined || mode === 'danger-full-access') {
    return { cwd: workdir, path: searchPath, confine: undefined, refused, keep: () => true, display: path => path, verify: () => {} }
  }
  const root = resolve(workdir, searchPath ?? '.')
  const canonicalRoot = resolvedPath(root)
  const shown = searchPath ?? '.'
  if (refused(canonicalRoot)) {
    throw new SearchError(`${toolName} cannot search "${shown}": file access denied under the protected home`, 'SEARCH_SANDBOX_DENIED')
  }
  const cwd = searchPath === undefined ? canonicalRoot : workdir
  return {
    cwd,
    path: searchPath === undefined ? undefined : canonicalRoot,
    // A root the call is granted under a tool-readable entry, such as its session's spill directory, is hidden from a
    // confined run; it runs unconfined, which is safe because confined commands cannot write under the protected home.
    confine: toolReadableOnly(reads, canonicalRoot)
      ? undefined
      : (argv, signal) => sandbox.confine(argv, searchPolicy(ctx, exec, workdir), signal),
    refused,
    keep: (outputPath) => {
      const path = resolve(cwd, outputPath)
      return pathWithin(path, canonicalRoot) && !refused(path)
    },
    display: (outputPath) => {
      if (searchPath === undefined) return outputPath
      const rest = relative(canonicalRoot, resolve(cwd, outputPath))
      if (rest === '') return searchPath
      return searchPath.endsWith(sep) || searchPath.endsWith('/') ? `${searchPath}${rest}` : `${searchPath}${sep}${rest}`
    },
    verify: () => {
      if (resolvedPath(root) !== canonicalRoot || resolvedPath(canonicalRoot) !== canonicalRoot) {
        throw new SearchError(`${toolName} cannot search "${shown}": the search root changed while the search ran`, 'SEARCH_SANDBOX_DENIED')
      }
    },
  }
}

/** One ripgrep diagnostic for a file or directory the operating system refused to open. */
const ACCESS_DENIED_LINE = /^rg: (.+): (?:Permission denied|Operation not permitted) \(os error \d+\)$/u

/**
 * Whether a confined run's exit 2 reports only paths it could not open under the protected reads: a Landlock or
 * Seatbelt runner refuses them where bwrap shows an empty directory, and the search outside them is complete.
 */
function onlyProtectedDenials(target: SearchTarget, stderr: SubprocessOutputRead): boolean {
  if (stderr.lossy) return false
  const lines = stderr.text.split(/\r?\n/u).filter(line => line.trim().length > 0)
  return lines.length > 0 && lines.every((line) => {
    const denied = ACCESS_DENIED_LINE.exec(line)?.[1]
    return denied !== undefined && target.refused(resolve(target.cwd, denied))
  })
}

/** The abort failure every stage of a run reports once cancellation is observed. */
function abortedError(toolName: string): SearchError {
  return new SearchError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'SEARCH_ABORTED')
}

/**
 * Run the packaged ripgrep binary with a plain argv vector and return its
 * complete raw stdout. The working directory is the calling agent's session
 * current directory when available, else
 * `process.cwd()`. `exec.signal` is forwarded so the cooperative tool timeout
 * (`@deepseek-ai/dsh-tool-call-timeout-policy`) and caller cancellation terminate the
 * process tree.
 *
 * `--no-config` is prepended: a host `RIPGREP_CONFIG_PATH` (or `rg.conf` next
 * to the binary) can otherwise inject `--pre` and make ripgrep execute an
 * arbitrary preprocessor for every matched file. The tools never pass
 * `--follow`, so ripgrep follows a link only when it is the search root. When
 * the sandbox provider reports protected reads, the root is checked and pinned
 * and ripgrep runs confined ({@link searchTarget}); otherwise the spawn is a
 * plain `ctx.subprocess` call. The collect dispositions are the
 * seam's diagnostic-tail shape (no spill files): the tools never read a raw
 * spill path, and truncated stdout fails as `SEARCH_RAW_OUTPUT_OVERFLOW`.
 *
 * Exit semantics are tool-owned: exit 0 is success with results, exit 1 is
 * success with zero results (`noMatches`), anything else throws a
 * {@link SearchError} (abort/timeout → `SEARCH_ABORTED`, invalid pattern →
 * `SEARCH_INVALID_PATTERN`, the rest → `SEARCH_FAILED` /
 * `SEARCH_RAW_OUTPUT_OVERFLOW`). A confined run whose exit 2 reports only
 * protected paths it could not open is a success, and one whose runner failed
 * before ripgrep ran is `SEARCH_FAILED` whatever its exit code. Both
 * launch-time failure domains are
 * classified: a synchronous throw at spawn CREATION (a NUL in argv, an abort
 * racing the pre-check, a rejected `@vscode/ripgrep` resolution, a sandbox
 * that cannot confine the run) reports that
 * the command could not start, while a rejection of `handle.done` reports a
 * provider failure without claiming whether execution began. Both become
 * `SEARCH_FAILED` with the original as `cause`; an abort already observed by
 * creation time becomes `SEARCH_ABORTED` instead.
 *
 * @param ctx - the plugin context; execution uses its `subprocess` service, and its optional `sandbox` and
 *   `sandboxPolicy` services decide the protected-read check.
 * @param exec - the tool-execution context; supplies the owning Agent and the abort signal.
 * @param toolName - `glob` or `grep`, used in error messages.
 * @param search - the requested root and the argv builder (every model value an unquoted argv element; no shell layer exists).
 * @param rawOutputMaxBytes - cap on the complete raw stdout the tool will parse.
 * @param graceMs - the seam's terminate-escalation grace period.
 * @param stderrMaxBytes - cap on the retained stderr diagnostic tail.
 * @returns the complete stdout, the zero-result flag, the resolved workdir and the output-path filter.
 * @throws {SearchError} `SEARCH_SANDBOX_DENIED` when the root is protected or changed while the search ran.
 */
export async function runRipgrep(
  ctx: Context,
  exec: ToolExecution,
  toolName: string,
  search: RipgrepSearch,
  rawOutputMaxBytes: number,
  graceMs: number,
  stderrMaxBytes: number,
): Promise<RipgrepRun> {
  if (exec.signal.aborted) throw abortedError(toolName)
  const workdir = exec.agent === undefined
    ? process.cwd()
    : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const target = searchTarget(ctx, exec, toolName, workdir, search.path)
  let handle: SubprocessHandle
  let runnerFailureRules: readonly RunnerFailureRule[] = []
  try {
    let argv = [await resolveRgPath(), '--no-config', ...search.argv(target.path)]
    if (target.confine !== undefined) {
      const confined = await target.confine(argv, exec.signal)
      argv = confined.argv
      runnerFailureRules = confined.runnerFailureRules
    }
    handle = ctx.subprocess.spawn({
      argv,
      cwd: target.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: rawOutputMaxBytes },
        stderr: { maxBytes: stderrMaxBytes },
      },
      graceMs,
      signal: exec.signal,
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    // Node's spawn() throws synchronously for a NUL in argv, and the local
    // impl can throw synchronously when the signal aborts between the check
    // above and this call (or when the platform-package resolution or the
    // sandbox wrap rejects). The static narrowing that proves this re-check
    // "always false" cannot see AbortSignal state changes.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (exec.signal.aborted) throw abortedError(toolName)
    const detail = target.confine === undefined ? 'ripgrep launch failed' : `ripgrep could not be confined or launched: ${String(error)}`
    throw new SearchError(`${toolName} could not start its search command (${detail})`, 'SEARCH_FAILED', { cause: error })
  }
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new SearchError(`${toolName} subprocess failed before reporting an outcome (ripgrep provider failure)`, 'SEARCH_FAILED', { cause: error })
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) {
    throw new SearchError(`${toolName} search command produced no collected output streams`, 'SEARCH_FAILED')
  }
  // The signal can abort while the spawn is awaited; the static narrowing that
  // proves this re-check "always false" cannot see AbortSignal state changes.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (exec.signal.aborted) throw abortedError(toolName)
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new SearchError(`${toolName} search command was killed by signal ${outcome.signal ?? '(unknown)'}`, 'SEARCH_FAILED')
  }
  const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderr.text, runnerFailureRules)
  if (runnerFailure !== undefined) {
    throw new SearchError(
      `${toolName} could not run its search command: the sandbox runner failed (exit ${outcome.exitCode}): ${stderrExcerpt(stderr.text, stderr.lossy)}`,
      'SEARCH_FAILED',
    )
  }
  const protectedDenials = outcome.exitCode === 2 && target.confine !== undefined && onlyProtectedDenials(target, stderr)
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1 && !protectedDenials) {
    throw classifyRunFailure(toolName, outcome.exitCode, stderr.text, stderr.lossy)
  }
  const text = completeStdout(toolName, stdout, rawOutputMaxBytes)
  target.verify()
  return { stdout: text, noMatches: outcome.exitCode === 1, workdir, keep: target.keep, display: target.display }
}

/**
 * Map an `rg` output path to its display form: absolute paths inside the
 * resolved workdir become workdir-relative; everything else (relative output,
 * paths outside the workdir) passes through unchanged. Display-only —
 * returned paths are follow-up-readable in co-located workdir/filesystem
 * deployments where both resolve the same workspace (the documented v1
 * deployment requirement).
 *
 * @param path - one path as ripgrep printed it.
 * @param workdir - the resolved workdir the command ran in.
 * @returns the workdir-relative display path when possible, else `path` unchanged.
 */
export function toWorkdirRelative(path: string, workdir: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(workdir, path)
  if (rel.length === 0) return '.'
  if (rel === '..' || rel.startsWith(`..${sep}`)) return path
  return rel
}

/** One parsed match: the file, the 1-based line number, and the (possibly previewed) line text. */
export interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

/**
 * Bound one matched-line preview to `maxBytes` (UTF-8 boundary preserved) and
 * mark the cut. The cap is a per-line budget fact; the complete line stays in
 * the searched file for `read`.
 *
 * @param line - the matched line text (trailing newline already stripped).
 * @param maxBytes - the preview budget in bytes.
 * @returns the preview, suffixed with ` (line truncated)` when bytes were cut.
 */
export function previewLine(line: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(line)
  const kept = retainer.finish()
  return kept.truncated ? `${kept.text} (line truncated)` : kept.text
}

/**
 * Apply the shared inline cap to a canonical `grep` match list: preview each
 * retained line to `maxLineBytes` and keep the first `maxMatches`. The single
 * retention pass both the model-facing render ({@link module:@deepseek-ai/dsh-tool-fs-search/grep}
 * `formatGrepOutput`) and the search-card projection
 * ({@link module:@deepseek-ai/dsh-tool-fs-search/presentation} `grepSearchMeta`)
 * consume, so text and card never disagree about which matches survived.
 *
 * @param matches - every match the search parsed (the canonical value's matches).
 * @param maxMatches - the inline match cap (the `grepMaxMatches` config).
 * @param maxLineBytes - the per-matched-line preview budget in bytes.
 * @returns the retention outcome over the previewed matches.
 */
export function retainGrepMatches(matches: GrepMatch[], maxMatches: number, maxLineBytes: number): RetainedItems<GrepMatch> {
  const retainer = new ItemRetainer<GrepMatch>({ kind: 'head', maxItems: maxMatches })
  for (const match of matches) retainer.push({ ...match, line: previewLine(match.line, maxLineBytes) })
  return retainer.finish()
}

/**
 * Apply the shared inline cap to a canonical `glob` path list: keep the first
 * `maxResults`. The single retention pass both the model-facing render and the
 * search-card projection consume.
 *
 * @param paths - every path the search discovered (the canonical value's paths).
 * @param maxResults - the inline path cap (the `globMaxResults` config).
 * @returns the retention outcome over the paths.
 */
export function retainGlobPaths(paths: string[], maxResults: number): RetainedItems<string> {
  const retainer = new ItemRetainer<string>({ kind: 'head', maxItems: maxResults })
  for (const path of paths) retainer.push(path)
  return retainer.finish()
}

/**
 * Best-effort save of one COMPLETE formatted search result through
 * `ctx.spillStore.saveText()` — the model-facing recovery path for a capped
 * result. `spillStore` is read with `ctx.get()` (not static inject) because
 * formatted-result spill is optional; the spill owner is the calling agent's
 * session header id and the source is the tool execution identity. A missing
 * backend, a call with no session owner, or a `saveText()` rejection logs a
 * warning and returns `undefined` — the caller keeps the inline result and
 * reports that the complete result could not be saved; search success never
 * turns into `isError` because spill storage is unavailable.
 *
 * @param ctx - the plugin context; `spillStore` is looked up opportunistically.
 * @param exec - the tool-execution context; supplies the owning session, tool name, and call id.
 * @param suggestedName - the backend-sanitized filename hint (e.g. `grep-results.txt`).
 * @param content - the complete formatted result to persist.
 * @returns the saved spill reference, or `undefined` when the result could not be saved.
 */
export async function trySaveFormattedResult(
  ctx: Context,
  exec: ToolExecution,
  suggestedName: string,
  content: string,
): Promise<SpillRef | undefined> {
  const sessionId = exec.agent?.session.header.id
  if (sessionId === undefined) {
    ctx.logger.warn(`tool-fs-search: no session owner for ${exec.name} result; complete result not saved`)
    return undefined
  }
  const spillStore = ctx.get('spillStore')
  if (!spillStore) {
    ctx.logger.warn(`tool-fs-search: no ctx.spillStore backend loaded; complete ${exec.name} result not saved`)
    return undefined
  }
  const save: SaveTextSpill = {
    owner: { sessionId },
    source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
    suggestedName,
    content,
  }
  try {
    return await spillStore.saveText(save)
  } catch (error: unknown) {
    // Best-effort: a storage failure must never fail the search or hide the
    // inline result — the footer reports the unsaved remainder instead.
    ctx.logger.warn(`tool-fs-search: saveText failed for ${exec.name}: ${String(error)}; complete result not saved`)
    return undefined
  }
}
