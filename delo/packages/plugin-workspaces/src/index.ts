/**
 * @delo/plugin-workspaces: the `deloWorkspaces` provider. It creates folders under the root, imports a repository into a
 * new folder by `git clone` (with the token of the clone's host when a credential is configured), reads and writes a
 * workspace's `AGENTS.md`, and moves a folder with its workspaces to `root/.delo-trash` and back. The Service Definition
 * is `./service.ts`; this module provides it as a class plugin.
 * @module @delo/plugin-workspaces
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import { WorkspaceUnknownSessionError, type Workspace, type WorkspaceId } from '@deepseek-ai/dsh-workspace'
import schema from '@deepseek-ai/schemastery'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { checkProtectedFile, HomeLayoutError, readProtectedFile, resolveDeloHome } from '@delo/home'
import { cloneRepository } from './clone.ts'
import { INSTRUCTIONS, InstructionsRefusedError, readInstructions, writeInstructions } from './files.ts'
import { cloneUrlProblem, redactClone } from './git.ts'
import { folderName, WorkspaceRefusedError } from './service.ts'
import type {
  CreateRequest, DeloWorkspaces, ImportRequest, ImportRow, InstructionsRequest, InstructionsResponse, TrashEntry, WorkspacesListing,
} from './service.ts'
import { ImportRecord, TrashRecord, workspacesDomain } from './spec.ts'

/** The folder under the root that holds trashed folders. A folder name cannot start with a dot, so no workspace takes its name. */
const TRASH = '.delo-trash'

/** The mode of a folder the service creates under the root. */
const FOLDER_MODE = 0o755

/** The mode of the trash folder, which only the harness's user reaches. */
const TRASH_MODE = 0o700

/** Milliseconds in a day: the keep time of a finished import and the unit of the trash days. */
const DAY_MS = 24 * 60 * 60 * 1000

/** The longest reason an import keeps, in characters. */
const MAX_REASON = 500

/** The reason of an import that was cloning when the harness stopped. */
const RESTART_REASON = 'the harness restarted while it cloned'

/** The reason of an import whose clone could not start, when the provider gave git no error pipe or no process. */
const GIT_FAILED = 'git could not run'

/** The plugin's name in its log lines. */
const PLUGIN = 'delo-workspaces'

/** Text a bare host or host:port lacks: whitespace and control characters, `/`, `\`, `?`, `#`, `@`, and a `:` with no port after it. */
const NOT_HOST_TEXT = /[\x00-\x20\x7f/\\?#@]|:$/

/** The workspaces plugin's configuration. */
export interface Config {
  /** The absolute directory that holds the workspace folders and the trash. It is created at load when it is missing. */
  readonly root: string
  /** How many days the trash keeps a folder before the folder is deleted for good. */
  readonly trashDays: number
  /** The longest `AGENTS.md`, in UTF-8 bytes, read or written. */
  readonly instructionsMaxBytes: number
  /** How long a clone may take, in milliseconds; git is stopped when the time passes. */
  readonly importTimeoutMs: number
  /**
   * The token for clones from one host. `host` is a bare host or host:port, matched in lower case with the https port 443
   * dropped; `file` is an absolute path to the token file, directly in the home's `secrets` directory. The file is read for
   * each clone from that host and given to that clone only. No clone reads git's system or global configuration, so a private
   * repository needs this credential.
   */
  readonly credential?: { readonly host: string, readonly file: string }
  /**
   * The CA bundle git trusts for every clone (`http.sslCAInfo`). It replaces the system bundle, so it must include the
   * public roots too.
   */
  readonly caFile?: string
}

/** The plugin's configuration schema. Each limit has its default; the paths have none. */
export const Config: schema<Config> = schema.object({
  root: schema.string().pattern(/^\/.*[^/]$/).required().description('The absolute directory that holds the workspace folders and the trash; created when it is missing.'),
  trashDays: schema.natural().min(1).max(3650).default(30).description('How many days the trash keeps a folder before the folder is deleted for good.'),
  instructionsMaxBytes: schema.natural().min(1).max(16 * 1024 * 1024).default(65_536).description('The longest AGENTS.md read or written, in UTF-8 bytes.'),
  importTimeoutMs: schema.natural().min(1000).max(86_400_000).default(1_800_000).description('How long a repository clone may take, in milliseconds.'),
  // A union, not a plain object: schemastery fills an absent object with {}, which would then fail its required fields.
  credential: schema.union([schema.object({
    host: schema.string().required().description('The clone URL host, with its port when it has one, that receives the token; case does not matter, and the https port 443 may be written and is dropped.'),
    file: schema.string().pattern(/^\/.*[^/]$/).required().description('The absolute path of the token file, directly in the home\'s secrets directory.'),
  })]).description('A token for clones from one host, read from a token file in the home\'s secrets directory.'),
  caFile: schema.string().pattern(/^\/.*[^/]$/).description('The CA bundle git trusts for every clone; it replaces the system bundle, so include the public roots too.'),
})

/** A chat's id, as the workspace registry brands it. */
type SessionId = Workspace['sessionIds'][number]

/** The state a mounted plugin holds: its canonical root and the two tables. */
interface Mounted {
  /** The root's canonical path; every workspace folder is a direct child of it. */
  readonly root: string
  readonly imports: KvTable<string, ImportRecord>
  readonly trash: KvTable<string, TrashRecord>
}

/**
 * The `deloWorkspaces` provider: the folders under the root, their imports and their trash, over upstream's workspace
 * registry. Mounting it resolves the Delo home, checks the root and the credential file, creates the root and opens the
 * storage. Disposing it ends the clones in flight and then closes the storage.
 */
export class DeloWorkspacesService extends Service implements DeloWorkspaces {
  static inject = ['workspaceRegistry', 'storageDomain', 'subprocess']
  static Config = Config

  private mounted?: Mounted
  /** The credential as the clones match it, its host normalised at load; undefined without a credential. */
  private credential?: NonNullable<Config['credential']>
  /** Aborted when the plugin is disposed; ends the clones in flight. */
  private readonly lifetime = new AbortController()
  /** The clones in flight, by import id. */
  private readonly running = new Map<string, Promise<void>>()
  /** git's latest progress line for each import in flight. */
  private readonly progress = new Map<string, string>()
  /** The tail of the queue of changes to the folders, the registry and the rows. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - the plugin context with the injected services.
   * @param config - the root, the limits and the optional credential and CA bundle.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'deloWorkspaces')
  }

  /**
   * Open the storage, prepare the root, and start the sweep of the imports and the trash in the background.
   * @throws Error when the root is the Delo home, lies inside it or contains it, or the credential file is outside the home's secrets directory; HomeLayoutError when the home or the credential file is refused.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspacesDomain)
    this.ctx.effect(() => async () => {
      this.lifetime.abort(new Error(`${PLUGIN}: the plugin is disposed`))
      await Promise.allSettled([...this.running.values()])
      await domain.close()
    }, `${PLUGIN}: clones and storage`)
    const root = await this.prepareRoot()
    this.mounted = { root, imports: domain.table('imports'), trash: domain.table('trash') }
    void this.serial(() => this.sweep()).catch((error: unknown) => {
      this.warn(`the sweep at start failed: ${reasonOf(error)}`)
    })
  }

  /**
   * List the imports of the last day and the trash, after sweeping the imports a restart left, the finished imports older
   * than a day, and the trash entries past their time.
   * @returns the imports, newest first, and the trash, newest first.
   */
  list(): Promise<WorkspacesListing> {
    return this.call('listing the workspaces', () => this.serial(async () => {
      await this.sweep()
      return { imports: this.importRows(), trash: this.trashEntries() }
    }))
  }

  /**
   * Create a workspace as a new, empty folder of the root.
   * @param request - the folder name and the title, the folder name by default.
   * @returns the new workspace's id.
   * @throws WorkspaceRefusedError `invalid` for a name that is not a folder name, `taken` for a folder that exists, and `failed` when the registry refuses the folder, after which the folder is removed.
   */
  create(request: CreateRequest): Promise<{ readonly workspaces: readonly WorkspaceId[] }> {
    return this.call('creating the workspace', () => this.serial(async () => {
      const { root } = this.state()
      const directory = validFolder(request.directory)
      const path = join(root, directory)
      await this.claim(path)
      let workspace: Workspace
      try {
        workspace = await this.ctx.workspaceRegistry.create(path, request.title ?? directory)
      } catch (error) {
        await rmdir(path).catch((cleanup: unknown) => {
          this.warn(`the new folder stays after the registry refused it: ${reasonOf(cleanup)}`)
        })
        throw error
      }
      return { workspaces: [workspace.id] }
    }))
  }

  /**
   * Start cloning a repository into a new folder. The import shows in {@link list} until it ends, and a failed one leaves no folder.
   * @param request - the repository's https URL, and the folder, named after the repository by default.
   * @returns the import's id and its folder.
   * @throws WorkspaceRefusedError `invalid` for a URL git may not clone or a name that is not a folder name, and `taken` for a folder that exists.
   */
  startImport(request: ImportRequest): Promise<{ readonly import: string, readonly directory: string }> {
    return this.call('starting the import', () => this.serial(async () => {
      const { root, imports } = this.state()
      const problem = cloneUrlProblem(request.url)
      if (problem !== undefined) throw new WorkspaceRefusedError('invalid', problem)
      const directory = validFolder(request.directory ?? folderOfUrl(request.url) ?? '')
      const path = join(root, directory)
      await this.claim(path)
      const id = randomUUID()
      try {
        // cloneUrlProblem refuses a query and a fragment, so the URL stored is the URL git receives.
        await imports.put(id, { directory, url: request.url, state: 'cloning', reason: null, workspace: null, startedAt: Date.now(), endedAt: null })
      } catch (error) {
        await rmdir(path).catch((cleanup: unknown) => {
          this.warn(`the folder of an import that was not recorded stays: ${reasonOf(cleanup)}`)
        })
        throw error
      }
      this.running.set(id, this.track(id, request.url, directory, path))
      return { import: id, directory }
    }))
  }

  /**
   * Read a workspace's `AGENTS.md`.
   * @param workspace - the workspace's id.
   * @returns the file's path, its text and its revision, each null without a file, and the longest file the service writes.
   * @throws WorkspaceRefusedError `not-found` for an unknown workspace, `outside` for a workspace outside the root, and `too-large` for a file longer than the limit.
   */
  instructions(workspace: WorkspaceId): Promise<InstructionsResponse> {
    return this.call('reading the instructions', async () => {
      const path = this.workspacePath(workspace)
      const maxBytes = this.config.instructionsMaxBytes
      const file = await instructionsRefusals(() => readInstructions(this.state().root, path.slice(this.state().root.length + 1), maxBytes))
      return { path: join(path, INSTRUCTIONS), text: file.text, revision: file.revision, maxBytes }
    })
  }

  /**
   * Write a workspace's `AGENTS.md`, or remove it with empty text, when its revision is still the one given.
   * @param request - the workspace, the text, and the revision it replaces, null for none.
   * @throws WorkspaceRefusedError `not-found` for an unknown workspace or a folder that is gone, `outside` for a workspace outside the root, `conflict` when the file changed, and `too-large` for a text over the limit.
   */
  setInstructions(request: InstructionsRequest): Promise<void> {
    return this.call('writing the instructions', async () => {
      const path = this.workspacePath(request.workspace)
      if (!(await exists(path))) throw new WorkspaceRefusedError('not-found', 'the workspace folder is gone')
      await instructionsRefusals(() => writeInstructions(this.state().root, path.slice(this.state().root.length + 1), request.text, request.revision, this.config.instructionsMaxBytes))
    })
  }

  /**
   * Move the folder that holds a workspace, with every workspace in it, to the trash. The chats of those workspaces are
   * archived first, and the work of an active chat is stopped; a failure before the folder moves unarchives them again.
   * @param request - the workspace.
   * @returns the trash entry.
   * @throws WorkspaceRefusedError `not-found` for an unknown workspace, `outside` for a workspace outside the root, and `failed` when the folder cannot be moved.
   */
  trash(request: { readonly workspace: WorkspaceId }): Promise<TrashEntry> {
    return this.call('moving the folder to the trash', () => this.serial(() => this.moveToTrash(request.workspace)))
  }

  /**
   * Move a trashed folder back and register its workspaces again, with their chats in their recorded order.
   * @param request - the trash entry's id.
   * @returns the restored workspaces' ids, in their recorded order.
   * @throws WorkspaceRefusedError `not-found` for an unknown entry or one whose folder is gone, and `taken` when the folder's name exists again.
   */
  restore(request: { readonly trash: string }): Promise<{ readonly workspaces: readonly WorkspaceId[] }> {
    return this.call('restoring the folder', () => this.serial(() => this.restoreFolder(request.trash)))
  }

  /**
   * The mounted state, which exists once the storage is open.
   * @returns the state.
   * @throws WorkspaceRefusedError `unavailable` before the storage is open.
   */
  private state(): Mounted {
    if (this.mounted === undefined) throw new WorkspaceRefusedError('unavailable', 'the workspaces service has not started yet')
    return this.mounted
  }

  /**
   * Run a provider operation, and turn a failure that is not a refusal into a `failed` refusal. The operation's message names
   * no path and no credential; the log keeps the failure.
   * @param action - what the operation does, in words, for the message.
   * @param body - the operation.
   * @returns the operation's result.
   * @throws WorkspaceRefusedError with the operation's own code, or `failed`.
   */
  private async call<T>(action: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body()
    } catch (error) {
      if (error instanceof WorkspaceRefusedError) throw error
      this.ctx.logger.error(`${PLUGIN}: ${action} failed: ${String(error)}`)
      throw new WorkspaceRefusedError('failed', `${action} failed (${reasonOf(error)})`)
    }
  }

  /**
   * Run a change to the folders, the registry or the rows after the changes queued before it, whatever those did.
   * @param change - the change.
   * @returns the change's result.
   */
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.then(change, change)
    this.queue = next
    return next
  }

  /**
   * Write one warning line to the harness's log.
   * @param message - the text, which holds no token.
   */
  private warn(message: string): void {
    this.ctx.logger.warn(`${PLUGIN}: ${message}`)
  }

  /**
   * Resolve the Delo home, refuse a root that is the home, lies inside it or contains it, normalise and check the credential, and
   * create the root.
   * @returns the root's canonical path.
   * @throws Error when the root overlaps the home, the credential host is not a bare host or host:port, or the credential file is outside the home's secrets directory; HomeLayoutError when a path is refused.
   */
  private async prepareRoot(): Promise<string> {
    const home = await canonicalOf((await resolveDeloHome(process.env)).path)
    const root = await canonicalOf(this.config.root)
    if (overlaps(root, home)) throw new Error(`${PLUGIN}: the workspaces root ${this.config.root} cannot be the Delo home, lie inside it or contain it`)
    if (this.config.credential !== undefined) {
      this.credential = { host: credentialHost(this.config.credential.host), file: this.config.credential.file }
      await this.checkCredential(home, this.credential.file)
    }
    await mkdir(root, { recursive: true, mode: FOLDER_MODE })
    return root
  }

  /**
   * Check the credential file at load: it must sit directly in the home's secrets directory and pass the protected-file check.
   * @param home - the home's canonical path.
   * @param file - the configured token file.
   * @throws Error when the file is not directly in the secrets directory; HomeLayoutError when the file is refused.
   */
  private async checkCredential(home: string, file: string): Promise<void> {
    const secrets = join(home, DELO_HOME_ENTRIES.secrets)
    if (dirname(await canonicalOf(file)) !== secrets) {
      throw new Error(`${PLUGIN}: the credential file must be directly in the home's ${DELO_HOME_ENTRIES.secrets} directory`)
    }
    await checkProtectedFile(file)
  }

  /**
   * Make a new folder with mode 0755, refusing a folder that exists.
   * @param path - the folder's absolute path.
   * @throws WorkspaceRefusedError `taken` when the path exists.
   */
  private async claim(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: FOLDER_MODE })
    } catch (error) {
      if (codeOf(error) === 'EEXIST') throw new WorkspaceRefusedError('taken', `${basename(path)} exists already`)
      throw error
    }
  }

  /**
   * Start one clone in the background: its task settles its row and is removed from the clones in flight when it ends.
   * @param id - the import's id.
   * @param url - the clone URL.
   * @param directory - the folder's name.
   * @param path - the folder's absolute path.
   * @returns the task, which never rejects.
   */
  private track(id: string, url: string, directory: string, path: string): Promise<void> {
    return this.clone(id, url, directory, path)
      .catch((error: unknown) => {
        this.ctx.logger.error(`${PLUGIN}: import ${id} could not be recorded: ${reasonOf(error)}`)
      })
      .finally(() => {
        this.running.delete(id)
        this.progress.delete(id)
      })
  }

  /**
   * Clone one import's repository into its folder, then settle its row: a clone that succeeds becomes a registered workspace,
   * and a clone that fails leaves no folder, with its reason kept. A disposed plugin returns without writing the row, which
   * the next start settles.
   * @param id - the import's id.
   * @param url - the clone URL.
   * @param directory - the folder's name.
   * @param path - the folder's absolute path.
   */
  private async clone(id: string, url: string, directory: string, path: string): Promise<void> {
    const timeout = AbortSignal.timeout(this.config.importTimeoutMs)
    let token: string | undefined
    let reason: string | undefined
    try {
      token = await this.tokenFor(url)
    } catch (error) {
      reason = credentialReason(error)
    }
    const secrets = token === undefined ? [] : [token, encodeURIComponent(token)]
    try {
      if (reason === undefined) {
        const result = await cloneRepository({
          subprocess: this.ctx.subprocess,
          // The process environment boundary: the clone reads its environment only from this argument.
          env: process.env,
          url,
          directory: path,
          token,
          extraCaFile: this.config.caFile,
          timeoutMs: this.config.importTimeoutMs,
          signal: AbortSignal.any([this.lifetime.signal, timeout]),
          warn: (message) => { this.warn(redactClone(message, secrets)) },
          onProgress: (line) => { this.progress.set(id, line) },
        })
        if (!result.ok) reason = timeout.aborted ? this.timeoutReason() : result.reason
      }
    } catch (error) {
      // cloneRepository rejects only when the provider returns no error pipe for the spawn; the log keeps the message, redacted.
      this.ctx.logger.error(`${PLUGIN}: the clone for import ${id} could not start: ${redactClone(String(error), secrets)}`)
      reason = GIT_FAILED
    }
    if (this.lifetime.signal.aborted) return
    if (reason === undefined) {
      try {
        const workspace = await this.serial(() => this.ctx.workspaceRegistry.create(path, directory))
        await this.finish(id, { state: 'done', reason: null, workspace: workspace.id })
        return
      } catch (error) {
        reason = `the workspace could not be added (${reasonOf(error)})`
      }
    }
    await this.serial(() => this.discard(directory))
    await this.finish(id, { state: 'failed', reason: redactClone(reason, secrets).slice(0, MAX_REASON), workspace: null })
  }

  /**
   * The token for a clone URL: the credential file's content, read now, when the URL's host is the credential's host.
   * @param url - the clone URL.
   * @returns the token, or undefined when the URL's host has no credential.
   * @throws the failure of reading the credential file, whose message may name the file.
   */
  private async tokenFor(url: string): Promise<string | undefined> {
    const credential = this.credential
    if (credential === undefined || new URL(url).host !== credential.host) return undefined
    return (await readProtectedFile(credential.file)).toString('utf8').trim()
  }

  /**
   * The reason of a clone that passed its time limit, in minutes.
   * @returns the reason.
   */
  private timeoutReason(): string {
    return `the clone took longer than ${String(Number((this.config.importTimeoutMs / 60_000).toFixed(2)))} minutes`
  }

  /**
   * Record an import's outcome on its row.
   * @param id - the import's id.
   * @param outcome - the new state, reason and workspace.
   */
  private async finish(id: string, outcome: Pick<ImportRecord, 'state' | 'reason' | 'workspace'>): Promise<void> {
    const { imports } = this.state()
    const record = imports.get(id)
    if (record === undefined) return
    await imports.put(id, { ...record, ...outcome, endedAt: Date.now() })
  }

  /**
   * Remove a folder that no workspace holds, with everything in it. The removal does not follow a link inside the folder. A
   * failure is logged and leaves the folder in place.
   * @param directory - the folder's name.
   */
  private async discard(directory: string): Promise<void> {
    const path = join(this.state().root, directory)
    if (this.holder(path) !== undefined) {
      this.warn(`${directory} holds a workspace, so it stays`)
      return
    }
    try {
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      this.warn(`removing ${directory} failed, so it stays: ${reasonOf(error)}`)
    }
  }

  /**
   * The registered workspace at a folder or inside it.
   * @param path - the folder's canonical path.
   * @returns the workspace, or undefined when none is registered there.
   */
  private holder(path: string): Workspace | undefined {
    return this.ctx.workspaceRegistry.list().find(workspace => isWithin(path, workspace.path))
  }

  /**
   * Sweep the imports and the trash. Runs inside the queue. An import this process is not running is settled: a folder a
   * workspace holds makes the import done, and any other folder is removed with the import failed for the restart. A finished
   * import older than a day is deleted. A trash entry whose folder is gone is forgotten, and one past its time is purged.
   */
  private async sweep(): Promise<void> {
    const { root, imports, trash } = this.state()
    const now = Date.now()
    for (const [id, record] of [...imports.entries()]) {
      if (record.state === 'cloning') {
        if (!this.running.has(id)) await this.settleRestarted(id, record, now)
      } else if ((record.endedAt ?? record.startedAt) < now - DAY_MS) {
        await imports.delete(id)
      }
    }
    for (const [id, record] of [...trash.entries()]) {
      const folder = join(root, TRASH, id)
      if (!(await exists(folder))) {
        await trash.delete(id)
      } else if (record.deleteAt <= now) {
        try {
          await rm(folder, { recursive: true, force: true })
          await trash.delete(id)
        } catch (error) {
          this.warn(`purging a trashed folder failed, so it stays: ${reasonOf(error)}`)
        }
      }
    }
  }

  /**
   * Settle an import that this process is not running, as {@link sweep} describes.
   * @param id - the import's id.
   * @param record - the import's row.
   * @param now - the sweep's time in milliseconds since the epoch.
   */
  private async settleRestarted(id: string, record: ImportRecord, now: number): Promise<void> {
    const { root, imports } = this.state()
    const held = this.holder(join(root, record.directory))
    if (held !== undefined) {
      await imports.put(id, { ...record, state: 'done', reason: null, workspace: held.id, endedAt: now })
      return
    }
    await this.discard(record.directory)
    await imports.put(id, { ...record, state: 'failed', reason: RESTART_REASON, endedAt: now })
  }

  /**
   * The imports the listing shows: every import still cloning, and the finished ones of the last day, newest first.
   * @returns the rows.
   */
  private importRows(): ImportRow[] {
    const since = Date.now() - DAY_MS
    return [...this.state().imports.entries()]
      .filter(([, record]) => record.state === 'cloning' || (record.endedAt ?? record.startedAt) >= since)
      .sort(([, left], [, right]) => right.startedAt - left.startedAt)
      .map(([id, record]) => ({
        id,
        directory: record.directory,
        url: record.url,
        state: record.state,
        reason: record.reason,
        progress: record.state === 'cloning' ? (this.progress.get(id) ?? null) : null,
      }))
  }

  /**
   * The trash entries, newest first.
   * @returns the entries.
   */
  private trashEntries(): TrashEntry[] {
    return [...this.state().trash.entries()]
      .sort(([, left], [, right]) => right.trashedAt - left.trashedAt)
      .map(([id, record]) => ({
        id,
        directory: record.directory,
        deleteAt: record.deleteAt,
        workspaces: record.workspaces.map(({ title, path }) => ({ title, path })),
      }))
  }

  /**
   * The canonical path of a registered workspace, which must lie inside the root.
   * @param id - the workspace's id.
   * @returns the path.
   * @throws WorkspaceRefusedError `not-found` for an unknown id and `outside` for a path outside the root.
   */
  private workspacePath(id: WorkspaceId): string {
    const { root } = this.state()
    const workspace = this.ctx.workspaceRegistry.get(id)
    if (workspace === undefined) throw new WorkspaceRefusedError('not-found', 'no workspace has that id')
    if (workspace.path === root || !isWithin(root, workspace.path)) {
      throw new WorkspaceRefusedError('outside', 'the workspace is not inside the workspaces root')
    }
    return workspace.path
  }

  /**
   * The name of the root's folder that holds a path inside the root.
   * @param path - a path inside the root.
   * @returns the folder's name.
   * @throws WorkspaceRefusedError `outside` when the first name below the root is not a folder name.
   */
  private folderOf(path: string): string {
    const { root } = this.state()
    const folder = path.slice(root.length + 1).split(sep)[0] ?? ''
    if (!folderName.safeParse(folder).success) throw new WorkspaceRefusedError('outside', 'the workspace is not inside a folder of the workspaces root')
    return folder
  }

  /**
   * Move the folder that holds a workspace to the trash. Runs inside the queue.
   * @param id - the workspace's id.
   * @returns the trash entry.
   */
  private async moveToTrash(id: WorkspaceId): Promise<TrashEntry> {
    const { root, trash } = this.state()
    const registry = this.ctx.workspaceRegistry
    const folder = this.folderOf(this.workspacePath(id))
    const top = join(root, folder)
    const held = registry.list().filter(workspace => isWithin(top, workspace.path))
    const archivedBefore = new Set<string>(registry.archivedSessionIds)
    const archivedNow: SessionId[] = []
    const now = Date.now()
    const trashId = randomUUID()
    const record: TrashRecord = { directory: folder, trashedAt: now, deleteAt: now + this.config.trashDays * DAY_MS, workspaces: [] }
    try {
      for (const workspace of held) {
        const sessions: SessionId[] = [...workspace.sessionIds]
        const archived: SessionId[] = []
        for (const session of sessions) {
          if (archivedBefore.has(session)) continue
          try {
            await registry.archiveSession(session, { stopActivity: true })
          } catch (error) {
            if (error instanceof WorkspaceUnknownSessionError) continue
            throw error
          }
          archived.push(session)
          archivedNow.push(session)
        }
        record.workspaces.push({
          title: workspace.title,
          path: workspace.path,
          sessions: sessions.map(String),
          archived: archived.map(String),
        })
      }
      await mkdir(join(root, TRASH), { mode: TRASH_MODE, recursive: true })
      await trash.put(trashId, record)
      try {
        await rename(top, join(root, TRASH, trashId))
      } catch (error) {
        await trash.delete(trashId)
        throw error
      }
    } catch (error) {
      await this.unarchive(archivedNow)
      throw error
    }
    for (const workspace of held) {
      await registry.delete(workspace.id).catch((error: unknown) => {
        this.warn(`a workspace stays registered after its folder moved to the trash: ${reasonOf(error)}`)
      })
    }
    return {
      id: trashId,
      directory: folder,
      deleteAt: record.deleteAt,
      workspaces: record.workspaces.map(({ title, path }) => ({ title, path })),
    }
  }

  /**
   * Move a trashed folder back and register its workspaces again. Runs inside the queue.
   * @param id - the trash entry's id.
   * @returns the restored workspaces' ids, in their recorded order.
   */
  private async restoreFolder(id: string): Promise<{ readonly workspaces: readonly WorkspaceId[] }> {
    const { root, trash } = this.state()
    const registry = this.ctx.workspaceRegistry
    const record = trash.get(id)
    if (record === undefined) throw new WorkspaceRefusedError('not-found', 'no trash entry has that id')
    const source = join(root, TRASH, id)
    if (!(await exists(source))) throw new WorkspaceRefusedError('not-found', 'the trash entry\'s folder is gone')
    const target = join(root, record.directory)
    if (await exists(target)) throw new WorkspaceRefusedError('taken', `${record.directory} exists again; rename it to restore this one`)
    await rename(source, target)
    const restored: WorkspaceId[] = []
    // The registry prepends each workspace it creates, so the last workspace is created first to keep the recorded order.
    for (const entry of [...record.workspaces].reverse()) {
      let workspace: Workspace
      try {
        workspace = await registry.create(entry.path, entry.title)
      } catch (error) {
        this.warn(`a workspace could not be registered again: ${reasonOf(error)}`)
        continue
      }
      restored.unshift(workspace.id)
      for (const session of [...entry.sessions].reverse()) {
        await workspace.attachSession(brandString<SessionId>(session)).catch((error: unknown) => {
          this.warn(`a chat could not rejoin its workspace: ${reasonOf(error)}`)
        })
      }
      await this.unarchive(entry.archived)
    }
    // A row left behind is removed by the next sweep, because its folder is no longer in the trash.
    await trash.delete(id).catch((error: unknown) => {
      this.warn(`a restored trash entry stays recorded: ${reasonOf(error)}`)
    })
    return { workspaces: restored }
  }

  /**
   * Unarchive chats that a trash archived and then did not move, or that a restore gives back.
   * @param sessions - the chats' ids.
   */
  private async unarchive(sessions: readonly string[]): Promise<void> {
    for (const session of sessions) {
      await this.ctx.workspaceRegistry.unarchiveSession(brandString<SessionId>(session)).catch((error: unknown) => {
        this.warn(`a chat stays archived: ${reasonOf(error)}`)
      })
    }
  }
}

export default DeloWorkspacesService

/**
 * The system error code of a failure, such as `ENOENT`.
 * @param error - the failure.
 * @returns the code, or undefined when the failure has none.
 */
function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/**
 * The reason a failure gives in a message that may reach the person: its system error code, which names no path.
 * @param error - the failure.
 * @returns the code, or `unexpected error`.
 */
function reasonOf(error: unknown): string {
  return codeOf(error) ?? 'unexpected error'
}

/**
 * Whether a path exists, without following a symbolic link at its end.
 * @param path - the absolute path.
 * @returns true when `lstat` finds the path.
 * @throws the failure of `lstat` other than a missing path.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false
    throw error
  }
}

/**
 * A path with every symbolic link in its existing part resolved; the part that does not exist yet stays as written.
 * @param path - the absolute path.
 * @returns the canonical path.
 */
async function canonicalOf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error
    const parent = dirname(path)
    return parent === path ? path : join(await canonicalOf(parent), basename(path))
  }
}

/**
 * A path spelled the way the platform compares paths: folded to lower case on macOS and Windows, where the default file
 * system ignores case.
 * @param path - the path.
 * @returns the comparable spelling.
 */
function comparable(path: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path
}

/**
 * Whether a path is a directory or lies inside one.
 * @param parent - the directory, canonical.
 * @param path - the path, canonical.
 * @returns true when `path` is `parent` or lies below it.
 */
function isWithin(parent: string, path: string): boolean {
  const base = comparable(parent)
  const key = comparable(path)
  return key === base || key.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * Whether one canonical path is the other or lies inside it.
 * @param left - a canonical path.
 * @param right - a canonical path.
 * @returns true when either path contains the other.
 */
function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

/**
 * The folder name a clone URL gives: its last path segment without a `.git` suffix.
 * @param url - the clone URL.
 * @returns the name, or undefined when the URL gives no folder name.
 */
function folderOfUrl(url: string): string | undefined {
  const segment = new URL(url).pathname.split('/').filter(part => part !== '').at(-1) ?? ''
  const name = segment.replace(/\.git$/, '')
  return folderName.safeParse(name).success ? name : undefined
}

/**
 * The folder name, when the service takes it.
 * @param directory - the name.
 * @returns the name.
 * @throws WorkspaceRefusedError `invalid` when the name is not a folder name.
 */
function validFolder(directory: string): string {
  if (!folderName.safeParse(directory).success) {
    throw new WorkspaceRefusedError('invalid', 'the folder name must start with a letter or digit and hold up to 100 letters, digits, dots, underscores or hyphens')
  }
  return directory
}

/**
 * Run an instructions-file call and answer its refusal as the service's refusal with the same code.
 * @param body - the call.
 * @returns the call's result.
 * @throws WorkspaceRefusedError with the file's refusal code, and the file's error otherwise.
 */
async function instructionsRefusals<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof InstructionsRefusedError) throw new WorkspaceRefusedError(error.code, error.message)
    throw error
  }
}

/**
 * The configured credential host as a clone URL's host spells it: lower case, with the https default port 443 dropped and any
 * other port kept.
 * @param host - the configured host, with its port when it has one.
 * @returns the normalised host.
 * @throws Error naming `credential.host` when the value is not a bare host or host:port; the message names no part of the value.
 */
function credentialHost(host: string): string {
  const url = URL.parse(`https://${host}`)
  const bare = url !== null && url.hostname !== '' && url.username === '' && url.password === '' && url.pathname === '/'
    && url.search === '' && url.hash === '' && !NOT_HOST_TEXT.test(host)
  if (!bare) throw new Error(`${PLUGIN}: credential.host must be a bare host or host:port, without a scheme, path, user name or space`)
  return url.host
}

/**
 * The reason a credential file gives when it cannot be read. It names the refusal code or the system code, never the path.
 * @param error - the failure.
 * @returns the reason.
 */
function credentialReason(error: unknown): string {
  if (error instanceof HomeLayoutError) return `the credential file is refused (${error.code})`
  return `the credential file cannot be read (${reasonOf(error)})`
}
