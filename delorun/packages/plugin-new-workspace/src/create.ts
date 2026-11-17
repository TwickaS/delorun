/**
 * The {@link CREATE_PATH} route: make a new, empty folder inside the configured roots, optionally start a Git repository
 * in it, and add it as a workspace. The folder is held against the roots and the locations Delorun never adds before
 * anything is made; its parent is created when missing. Git runs with the clone's environment (no prompts, hooks off,
 * filters off) and an empty template, so nothing from the person's Git templates runs or is copied in; it adds a short
 * `.gitignore`. When Git cannot start the folder stays, without Git, and the answer says so. When the folder cannot be
 * added as a workspace, the folder this route made is removed.
 * @module @delorun/plugin-new-workspace/create
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { cloneEnvironment, HARDENED_CONFIG, preparedParent, type GitRunner } from './clone.ts'
import { isFolderName } from './clone-address.ts'
import { codeOf } from './location.ts'
import { registerFolder, type AddWorkspaceDeps } from './workspace-route.ts'
import { readBody, reply } from './http.ts'
import { CreateRequest, type CreateAnswer, type CreateProblem } from './wire.ts'

/** The `.gitignore` a new repository starts with: files a system or an editor leaves behind, and local secrets. */
export const STARTER_GITIGNORE = '# Files your system or editor leaves behind\n.DS_Store\nThumbs.db\n*.swp\n\n# Local secrets\n.env\n.env.*\n'

/** What the create route needs from the harness. */
export interface CreateDeps extends AddWorkspaceDeps {
  /** The folders a new folder may be made in, as the row configures them. */
  readonly roots: readonly string[]
  /** Runs Git. */
  readonly git: GitRunner
  /** The most time `git init` may take, in milliseconds. */
  readonly timeoutMs: number
  /**
   * Record the folder a new folder went in, so the next one starts there; it never rejects.
   * @param parent - the folder.
   */
  readonly remember: (parent: string) => Promise<void>
}

/**
 * Start a Git repository in a new, empty folder and add the starter `.gitignore`.
 * @param folder - the folder this route just made.
 * @param deps - Git, its timeout, the environment and the log.
 * @returns whether the repository was started.
 */
export async function initRepository(folder: string, deps: Pick<CreateDeps, 'git' | 'timeoutMs' | 'env' | 'warn'>): Promise<boolean> {
  // An empty template: Git copies nothing from the person's own templates, hooks included.
  const template = await mkdtemp(join(tmpdir(), 'delorun-init-template-'))
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort('timeout') }, deps.timeoutMs)
  try {
    const outcome = await deps.git([...HARDENED_CONFIG, 'init', '--quiet', `--template=${template}`, '--', folder], cloneEnvironment(deps.env), abort.signal, () => {})
    if (outcome.kind !== 'exited' || outcome.code !== 0) {
      deps.warn(`git init did not start a repository: ${outcome.kind === 'missing' ? 'no-git' : abort.signal.aborted ? 'timeout' : 'failed'}`)
      return false
    }
    await writeFile(join(folder, '.gitignore'), STARTER_GITIGNORE, { flag: 'wx' })
    return true
  } finally {
    clearTimeout(timer)
    await rm(template, { recursive: true, force: true })
  }
}

/**
 * Handle one request to make a folder and add it as a workspace.
 * @param request - the `POST` request carrying {@link CreateRequest}.
 * @param deps - the roots, Git, the registry, the environment and the log.
 * @returns 200 `added`, 422 `refused` with the problem, 400 for a request that cannot be read, or 500 `failed` when the
 * folder cannot be checked, made or added.
 */
export async function createWorkspace(request: Request, deps: CreateDeps): Promise<Response> {
  const body = await readBody(request, CreateRequest)
  if (body === undefined) return reply(400, { error: 'the request must be JSON with parent, name and git' })
  const refuse = (problem: CreateProblem): Response => reply(422, { result: 'refused', problem } satisfies CreateAnswer)
  if (!isFolderName(body.name)) return refuse('name-form')
  if (!isAbsolute(body.parent)) return refuse('not-absolute')
  const folder = join(body.parent, body.name)
  const problem = await preparedParent(body.parent, folder, deps)
  if (problem === 'unresolved') return reply(500, { result: 'failed' } satisfies CreateAnswer)
  if (problem !== undefined) return refuse(problem)
  try {
    // Not recursive: an existing entry, a symbolic link included, is never taken over.
    await mkdir(folder)
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return refuse('exists')
    deps.warn(`a new folder could not be made: ${codeOf(error)}`)
    return reply(500, { result: 'failed' } satisfies CreateAnswer)
  }
  const git = body.git ? await initRepository(folder, deps).catch((error: unknown) => {
    deps.warn(`git init stopped unexpectedly: ${codeOf(error)}`)
    return false
  }) : false
  const added = await registerFolder(folder, deps)
  if (added.result === 'added') {
    await deps.remember(body.parent)
    return reply(200, { result: 'added', workspaceId: added.workspaceId, path: added.path, git } satisfies CreateAnswer)
  }
  // The folder is this route's own and nothing is in it but what Git made, so it goes.
  await rm(folder, { recursive: true, force: true })
  return added.result === 'refused' ? refuse(added.problem) : reply(500, { result: 'failed' } satisfies CreateAnswer)
}
