/**
 * The bench's images: `delorun-bench:<commit>` (the candidate), `delorun-bench-prev:<tag>` (the previous release, for the
 * update stage) and `dsh-stock:<version>` (stock DeepSeek Harness at Delorun's current upstream base, read from the
 * repository's divergence ledger and never held as a constant). One Dockerfile builds all three; this module makes the
 * build context (a `git archive` of the commit, the mock model's sources, the bench's container scripts) and names the tags.
 *
 * @module @delorun/tools/compat-bench/images
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BENCH_LABEL } from './docker.ts'

/** The previous release tag the update stage starts from. */
export const PREVIOUS_RELEASE_TAG = 'v0.1.0-preview.2.7'

/** The three hosts and the helper image. */
export type ImageHost = 'delorun' | 'delorun-prev' | 'stock' | 'helper'

/** The folder of this module. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** The mock model's source files, which need nothing but Node. */
const MOCK_FILES = ['bin.ts', 'cli.ts', 'index.ts'] as const

/**
 * Run git in a repository.
 * @param repository - the repository.
 * @param args - git's arguments.
 * @returns standard output, trimmed.
 */
function git(repository: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

/**
 * The commit a tag, branch or `HEAD` names.
 * @param repository - the repository.
 * @param ref - the reference.
 * @returns the full commit hash.
 */
export function resolveCommit(repository: string, ref: string): string {
  return git(repository, ['rev-parse', '--verify', `${ref}^{commit}`])
}

/**
 * Delorun's upstream base, read from the ledger of a commit.
 * @param repository - the repository.
 * @param commit - the commit whose `delorun/upstream-patches.json` is read.
 * @returns the DSH version, for example `0.2.2-rc.3` from the ref `dsh-v0.2.2-rc.3`.
 * @throws Error when the ledger names no `dsh-v` ref.
 */
export function upstreamVersion(repository: string, commit: string): string {
  const ledger = JSON.parse(git(repository, ['show', `${commit}:delorun/upstream-patches.json`])) as { upstream?: { ref?: string } }
  const ref = ledger.upstream?.ref ?? ''
  const match = /^dsh-v(.+)$/.exec(ref)
  if (match?.[1] === undefined) throw new Error(`the ledger's upstream ref "${ref}" does not name a DSH version`)
  return match[1]
}

/**
 * The Playwright version a commit's lockfile resolves, so the image's browser matches the repository's.
 * @param repository - the repository.
 * @param commit - the commit.
 * @returns the stable version.
 * @throws Error when the lockfile names none.
 */
export function playwrightVersion(repository: string, commit: string): string {
  const lock = git(repository, ['show', `${commit}:pnpm-lock.yaml`])
  const match = /^ {2}playwright@(\d+\.\d+\.\d+):/m.exec(lock)
  if (match?.[1] === undefined) throw new Error('the lockfile names no stable Playwright version')
  return match[1]
}

/**
 * The tag of an image.
 * @param host - which image.
 * @param version - the commit (shortened to 12 characters), release tag or DSH version.
 * @returns the tag.
 */
export function imageTag(host: ImageHost, version: string): string {
  const name = { delorun: 'delorun-bench', 'delorun-prev': 'delorun-bench-prev', stock: 'dsh-stock', helper: 'bench-helper' }[host]
  return `${name}:${host === 'delorun' ? version.slice(0, 12) : version}`
}

/** What a build was asked for. */
export interface ImageRequest {
  /** The repository the commit comes from. */
  readonly repository: string
  /** `delorun`, `delorun-prev` or `stock`. */
  readonly host: Exclude<ImageHost, 'helper'>
  /** The commit for `delorun` (the candidate); defaults to `HEAD`. */
  readonly commit?: string
}

/** What a build resolved. */
export interface ImagePlan {
  /** The image tag. */
  readonly tag: string
  /** The Docker build target. */
  readonly target: 'delorun' | 'stock'
  /** The commit whose source is built, for the Delorun hosts. */
  readonly commit: string
  /** The build arguments. */
  readonly args: Readonly<Record<string, string>>
}

/**
 * Resolve what a build needs.
 * @param request - the request.
 * @returns the tag, target and build arguments.
 */
export function planImage(request: ImageRequest): ImagePlan {
  const candidate = resolveCommit(request.repository, request.commit ?? 'HEAD')
  const pinned = request.host === 'delorun-prev' ? resolveCommit(request.repository, PREVIOUS_RELEASE_TAG) : candidate
  const playwright = playwrightVersion(request.repository, candidate)
  if (request.host === 'stock') {
    const version = upstreamVersion(request.repository, candidate)
    return { tag: imageTag('stock', version), target: 'stock', commit: candidate, args: { DSH_VERSION: version, PLAYWRIGHT_VERSION: playwright } }
  }
  return {
    tag: request.host === 'delorun' ? imageTag('delorun', pinned) : imageTag('delorun-prev', PREVIOUS_RELEASE_TAG),
    target: 'delorun', commit: pinned, args: { BENCH_COMMIT: pinned, PLAYWRIGHT_VERSION: playwright },
  }
}

/**
 * Write the build context into a new folder.
 * @param request - the request.
 * @param plan - its plan.
 * @returns the folder, which the caller removes.
 */
export function writeContext(request: ImageRequest, plan: ImagePlan): string {
  const context = mkdtempSync(join(tmpdir(), 'delorun-bench-context-'))
  cpSync(join(HERE, 'docker', 'Dockerfile'), join(context, 'Dockerfile'))
  cpSync(join(HERE, 'container'), join(context, 'container'), { recursive: true })
  mkdirSync(join(context, 'mock'))
  writeFileSync(join(context, 'mock', 'package.json'), '{ "type": "module" }\n')
  const candidate = resolveCommit(request.repository, request.commit ?? 'HEAD')
  for (const file of MOCK_FILES) writeFileSync(join(context, 'mock', file), execFileSync('git', ['show', `${candidate}:packages/test-support/llm-mock-server/src/${file}`], { cwd: request.repository, maxBuffer: 16 * 1024 * 1024 }))
  if (plan.target === 'delorun') writeFileSync(join(context, 'source.tar'), execFileSync('git', ['archive', '--format=tar', plan.commit], { cwd: request.repository, maxBuffer: 4 * 1024 ** 3 }))
  else writeFileSync(join(context, 'source.tar'), '')
  return context
}

/**
 * Build one image.
 * @param request - the request.
 * @param log - receives Docker's output lines.
 * @returns the tag.
 * @throws Error when the build fails.
 */
export async function buildImage(request: ImageRequest, log: (line: string) => void = () => undefined): Promise<string> {
  const plan = planImage(request)
  const context = writeContext(request, plan)
  try {
    const args = ['build', '--target', plan.target, '--tag', plan.tag, '--label', BENCH_LABEL, '--progress', 'plain', ...Object.entries(plan.args).flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]), context]
    const code = await new Promise<number>((done) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DOCKER_BUILDKIT: '1' } })
      const forward = (chunk: Buffer): void => { for (const line of chunk.toString().split('\n')) if (line.trim() !== '') log(line) }
      child.stdout.on('data', forward)
      child.stderr.on('data', forward)
      child.on('close', (status) => { done(status ?? 1) })
    })
    if (code !== 0) throw new Error(`docker build of ${plan.tag} failed (exit ${String(code)})`)
    return plan.tag
  } finally {
    rmSync(context, { recursive: true, force: true })
  }
}

/**
 * Whether the container scripts the images copy are all present.
 * @returns true when the folder exists.
 */
export function containerScriptsPresent(): boolean {
  return existsSync(join(HERE, 'container', 'bin', 'delorun')) && readFileSync(join(HERE, 'docker', 'Dockerfile'), 'utf8').includes('AS base')
}
