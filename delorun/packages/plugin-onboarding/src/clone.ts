/**
 * The host half of the guide's Clone from Git choice: the {@link CLONE_PATH} and {@link CLONE_STATUS_PATH} routes. The
 * clone runs in the harness's process as the person, never inside a chat, and never asks for anything: Git's terminal
 * prompt, askpass programs, the Git Credential Manager's windows and SSH's interactive prompts are all off, and stdin is
 * closed, so a repository that needs a sign-in fails at once with `sign-in` instead of waiting. Only `https://`,
 * `ssh://` and `user@host:path` addresses are taken, and Git may speak only HTTPS and SSH, so a redirect cannot switch it
 * to another transport. The new folder must not exist or be empty, and it is held against the locations Delorun never adds
 * before Git runs; a failed clone removes only what its own Git created. One clone runs at a time, claimed before any wait.
 * Git runs with `core.hooksPath` off, the LFS filters off, `GIT_LFS_SKIP_SMUDGE` and a template that unsets every
 * `filter` attribute for the checkout, so no hook or filter from the person's Git configuration runs during it. An address with a sign-in in it is refused. Submodules are not cloned. No log line names the
 * address or Git's output, which can carry a token.
 * @module @delorun/plugin-onboarding/clone
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { hasUrlCredentials, isCloneAddress, isFolderName } from './clone-address.ts'
import { locationProblem, registerFolder, type AddWorkspaceDeps } from './workspace-route.ts'
import { CloneRequest, CloneStatusRequest, MAX_CLONE_BODY_BYTES, type CloneFailure, type CloneProblem, type CloneStart, type CloneStatus } from './wire.ts'

/** What one Git run came to: its exit code (`null` when it was killed), or that `git` could not be started. */
export type GitOutcome = { readonly kind: 'exited'; readonly code: number | null; readonly stderr: string } | { readonly kind: 'missing' }

/**
 * Runs Git with arguments and an environment, with stdin closed and stdout discarded.
 * @param args - the arguments after `git`.
 * @param env - the whole environment of the child.
 * @param signal - kills the child when it aborts.
 * @param onStderr - called with each piece of Git's progress output.
 * @returns what the run came to; it never rejects.
 */
export type GitRunner = (args: readonly string[], env: Readonly<Record<string, string>>, signal: AbortSignal, onStderr: (text: string) => void) => Promise<GitOutcome>

/**
 * Git run as a child process: no shell, stdin ignored, stdout discarded. On POSIX it leads its own process group, so an
 * abort kills the transport helpers Git starts with it; they hold stderr open, and without them the run would not end.
 */
export const spawnGit: GitRunner = (args, env, signal, onStderr) => new Promise((resolve) => {
  const group = process.platform !== 'win32'
  const child = spawn('git', [...args], { env, stdio: ['ignore', 'ignore', 'pipe'], shell: false, windowsHide: true, detached: group })
  const kill = (): void => {
    try {
      /* v8 ignore next -- Windows has no process groups; its helpers end when Git's pipes close */
      if (!group || child.pid === undefined) child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    /* v8 ignore next 3 -- a race: the group exits between the abort and the kill */
    } catch (_gone) {
      // The group already exited between the abort and the kill.
    }
  }
  signal.addEventListener('abort', kill, { once: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text: string) => {
    // Only the tail is kept for classifying a failure; progress lines can be long.
    stderr = (stderr + text).slice(-8192)
    onStderr(text)
  })
  child.on('error', (error: NodeJS.ErrnoException) => {
    signal.removeEventListener('abort', kill)
    // Git could not be started; a started Git reports through the close event.
    resolve(error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'exited', code: null, stderr: '' })
  })
  child.on('close', (code) => {
    signal.removeEventListener('abort', kill)
    resolve({ kind: 'exited', code, stderr })
  })
})

/** The variables the child keeps from the harness's environment: where it runs, who runs it, and how it reaches the network. */
const KEPT_VARIABLES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR',
  'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'XDG_CONFIG_HOME',
] as const

/**
 * The child's environment: the kept variables, with every way Git or SSH could ask the person for something turned off,
 * the transports limited to HTTPS and SSH, and Git's messages in English so a failure can be told apart.
 * @param env - the harness's environment.
 * @returns the child's environment.
 */
export function cloneEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const name of KEPT_VARIABLES) {
    const value = env[name]
    if (value !== undefined) kept[name] = value
  }
  return {
    ...kept,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_ALLOW_PROTOCOL: 'https:ssh',
    GIT_LFS_SKIP_SMUDGE: '1',
    LC_ALL: 'C',
  }
}

/**
 * Make the Git template directory whose `info/attributes` unsets the `filter` attribute for every path. It outranks the
 * repository's own `.gitattributes`, so no clean, smudge or process filter defined in the person's Git configuration
 * (Git offers no switch that turns all of them off) runs during checkout.
 * @returns the template directory; the caller removes it.
 */
export async function createCloneTemplate(): Promise<string> {
  const template = await mkdtemp(join(tmpdir(), 'delorun-clone-template-'))
  await mkdir(join(template, 'info'))
  await writeFile(join(template, 'info', 'attributes'), '* -filter\n')
  return template
}

/**
 * The arguments of the clone: hooks off, the LFS filters off, filters unset by the template, no submodules.
 * @param url - the repository address.
 * @param destination - the new folder.
 * @param template - the directory {@link createCloneTemplate} made.
 * @returns the arguments after `git`.
 */
export function cloneArguments(url: string, destination: string, template: string): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
    'clone', '--progress', '--no-recurse-submodules', `--template=${template}`, '--', url, destination,
  ]
}

/**
 * Tell a failed clone's cause from Git's English output; the output itself is never kept or shown.
 * @param stderr - what Git wrote.
 * @returns the failure.
 */
export function failureOf(stderr: string): CloneFailure {
  if (/Host key verification failed/iu.test(stderr)) return 'host-key'
  if (/terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Permission denied \(|returned error: 40[13]|Invalid username or password/iu.test(stderr)) return 'sign-in'
  if (/Repository not found|returned error: 404|does not appear to be a git repository|not found/iu.test(stderr)) return 'not-found'
  if (/Could not resolve host|Connection refused|Connection timed out|Network is unreachable|Could not connect|unable to access|Operation timed out/iu.test(stderr)) return 'network'
  return 'failed'
}

/**
 * @param path - a folder.
 * @returns `absent`, `empty`, or `used` for a folder with an entry or a path that is not a folder.
 */
async function destinationState(path: string): Promise<'absent' | 'empty' | 'used'> {
  try {
    if (!(await stat(path)).isDirectory()) return 'used'
  } catch (_absent) {
    // Nothing there yet: the clone creates it.
    return 'absent'
  }
  return (await readdir(path)).length === 0 ? 'empty' : 'used'
}

/** What the clone routes need from the harness. */
export interface CloneDeps extends AddWorkspaceDeps {
  /** Runs Git. */
  readonly git: GitRunner
  /** The most time a clone may take, in milliseconds. */
  readonly timeoutMs: number
}

/** One clone the harness knows. */
interface Job {
  status: CloneStatus
  readonly abort: AbortController
  /** Whether the destination folder existed, empty, before this job's Git ran; a job removes only what its own Git created. */
  existed: boolean
}

/** The most finished clones whose outcome is kept for the studio to read. */
const KEPT_JOBS = 16

/** The clone routes over one set of jobs. */
export interface CloneService {
  /**
   * Start a clone.
   * @param request - the `POST` request carrying {@link CloneRequest}.
   * @returns 200 `started` with the job's id, 422 `refused` with the problem, 400 for a request it cannot read, or 500
   * when the Delorun home cannot be resolved.
   */
  start(request: Request): Promise<Response>
  /**
   * Report a clone.
   * @param request - the `POST` request carrying {@link CloneStatusRequest}.
   * @returns 200 with the clone's status, or 400 for a request it cannot read.
   */
  status(request: Request): Promise<Response>
  /** Kill a running clone and forget every job; the harness calls it when the plugin stops. */
  dispose(): void
}

/**
 * Answer one JSON message.
 * @param status - the HTTP status.
 * @param answer - the message.
 * @returns the response, never cached.
 */
function reply(status: number, answer: CloneStart | CloneStatus | { readonly error: string }): Response {
  return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/**
 * Read a request's JSON body, refusing one over {@link MAX_CLONE_BODY_BYTES}.
 * @param request - the request.
 * @returns the parsed body, or undefined when it cannot be read.
 */
async function bodyOf(request: Request): Promise<unknown> {
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_CLONE_BODY_BYTES) return undefined
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return parsed
  } catch (_notJson) {
    // The parser's message quotes the body, so the request is only refused.
    return undefined
  }
}

/**
 * Create the clone routes' service.
 * @param deps - Git, the timeout, the registry, the environment and the log.
 * @returns the service.
 */
export function createCloneService(deps: CloneDeps): CloneService {
  const jobs = new Map<string, Job>()
  let running: Job | undefined
  const finish = (job: Job, status: CloneStatus): void => {
    job.status = status
    running = undefined
    // Drop the oldest outcomes beyond the kept number; a Map keeps insertion order, and only one clone runs at a time, so
    // every older job has finished.
    for (const id of jobs.keys()) {
      if (jobs.size <= KEPT_JOBS) break
      jobs.delete(id)
    }
  }
  const run = async (job: Job, url: string, destination: string): Promise<void> => {
    const timer = setTimeout(() => { job.abort.abort('timeout') }, deps.timeoutMs)
    let outcome: GitOutcome
    const template = await createCloneTemplate()
    try {
      outcome = await deps.git(cloneArguments(url, destination, template), cloneEnvironment(deps.env), job.abort.signal, (text) => {
        const percents = [...text.matchAll(/Receiving objects:\s+(\d{1,3})%/gu)]
        const last = percents.at(-1)
        if (last !== undefined) job.status = { state: 'running', percent: Math.min(100, Number(last[1])) }
      })
    } finally {
      clearTimeout(timer)
      await rm(template, { recursive: true, force: true })
    }
    if (outcome.kind === 'exited' && outcome.code === 0) {
      // The template's attributes were for the checkout only; filters the person sets up later must apply.
      await rm(join(destination, '.git', 'info', 'attributes'), { force: true })
      const added = await registerFolder(destination, deps)
      finish(job, added.result === 'added' ? { state: 'done', workspaceId: added.workspaceId, path: destination, kind: added.kind } : { state: 'failed', failure: 'add-failed' })
      return
    }
    const failure: CloneFailure = outcome.kind === 'missing' ? 'no-git' : job.abort.signal.aborted ? 'timeout' : failureOf(outcome.stderr)
    deps.warn(`a clone failed: ${failure}`)
    // Git leaves a folder it refused to use alone; it is not this job's.
    if (!/already exists and is not an empty directory/u.test(outcome.kind === 'exited' ? outcome.stderr : '')) await removeCreated(destination, job.existed)
    finish(job, { state: 'failed', failure })
  }
  return {
    async start(request) {
      const parsed = CloneRequest.safeParse(await bodyOf(request))
      if (!parsed.success) return reply(400, { error: 'the request must be JSON with url, parent and name' })
      const { url, parent, name } = parsed.data
      const refuse = (problem: CloneProblem): Response => reply(422, { result: 'refused', problem })
      if (!isCloneAddress(url)) return refuse('url-form')
      if (hasUrlCredentials(url)) return refuse('url-credentials')
      if (!isFolderName(name)) return refuse('name-form')
      if (!isAbsolute(parent)) return refuse('not-absolute')
      if (running !== undefined) return refuse('busy')
      // The claim comes before the first await, so a second start sees it.
      const job: Job = { status: { state: 'running' }, abort: new AbortController(), existed: false }
      running = job
      const destination = join(parent, name)
      const release = (): void => { running = undefined }
      const problem = await locationProblem(destination, deps)
      if (problem === 'unresolved') {
        release()
        return reply(500, { error: 'the Delorun home could not be resolved, so nothing is cloned' })
      }
      if (problem !== undefined) {
        release()
        return refuse(problem)
      }
      const state = await destinationState(destination)
      if (state === 'used') {
        release()
        return refuse('not-empty')
      }
      job.existed = state === 'empty'
      const id = randomUUID()
      jobs.set(id, job)
      void run(job, url, destination).catch((error: unknown) => {
        deps.warn(`a clone stopped unexpectedly: ${error instanceof Error ? error.name : 'unexpected failure'}`)
        finish(job, { state: 'failed', failure: 'failed' })
      })
      return reply(200, { result: 'started', job: id })
    },
    async status(request) {
      const parsed = CloneStatusRequest.safeParse(await bodyOf(request))
      if (!parsed.success) return reply(400, { error: 'the request must be JSON with a job' })
      return reply(200, jobs.get(parsed.data.job)?.status ?? { state: 'unknown' })
    },
    dispose() {
      for (const job of jobs.values()) job.abort.abort('stopped')
      jobs.clear()
      running = undefined
    },
  }
}

/**
 * Remove what a failed clone created: the folder when it did not exist before, or its entries when it was empty.
 * @param destination - the clone's folder.
 * @param existed - whether the folder existed, empty, before the clone.
 */
async function removeCreated(destination: string, existed: boolean): Promise<void> {
  try {
    if (!existed) {
      await rm(destination, { recursive: true, force: true })
      return
    }
    for (const entry of await readdir(destination)) await rm(join(destination, entry), { recursive: true, force: true })
  } catch (_gone) {
    // Git removes its own partial clone on most failures, so there may be nothing left to remove.
  }
}
