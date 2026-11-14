/**
 * A stand-in `delorunWorkspaces` provider over a temporary directory, for the
 * main chat's specs: each workspace is a folder of the root whose
 * `AGENTS.md` is read and written on disk against its revision. An import,
 * a trash and a restore are recorded and change no file, so a spec can show
 * that a refused call reached none of them.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WorkspaceRefusedError, type CreateRequest, type DelorunWorkspaces, type ImportRequest, type InstructionsRequest, type InstructionsResponse, type RenamePlan, type RenameRequest, type TrashEntry, type WorkspacesListing } from '@delorun/plugin-workspaces/service'

/** One fixture workspace, as the workspace registry stand-in lists it. */
export interface FixtureWorkspace {
  readonly id: WorkspaceId
  readonly path: string
  readonly title: string
}

/** A trash entry every fixture starts with. */
export const TRASHED: TrashEntry = { id: '00000000-0000-4000-8000-000000000001', directory: 'old', deleteAt: Date.UTC(2026, 10, 30), workspaces: [{ title: 'Old', path: '/fixture/old' }] }

const revisionOf = (text: string | null): string | null => (text === null ? null : createHash('sha256').update(text).digest('hex'))

/**
 * The stand-in provider.
 */
export class FixtureWorkspaces implements DelorunWorkspaces {
  /** Every call that would change something, in order. */
  readonly changes: (readonly [string, unknown])[] = []

  readonly workspaces: readonly FixtureWorkspace[]

  /**
   * @param workspaces - the fixture workspaces, each a folder that exists.
   */
  constructor(workspaces: readonly FixtureWorkspace[]) {
    this.workspaces = workspaces
  }

  /**
   * The workspace with an id.
   * @param id - its id.
   * @returns the workspace.
   */
  private find(id: WorkspaceId): FixtureWorkspace {
    const found = this.workspaces.find(workspace => workspace.id === id)
    if (found === undefined) throw new WorkspaceRefusedError('not-found', `no workspace has the id ${id}`)
    return found
  }

  /** @returns no imports and the fixture trash entry. */
  list(): Promise<WorkspacesListing> {
    return Promise.resolve({ imports: [], trash: [TRASHED] })
  }

  /**
   * @param request - the folder.
   * @returns a new id.
   */
  create(request: CreateRequest): Promise<{ readonly workspaces: readonly WorkspaceId[] }> {
    this.changes.push(['create', request])
    return Promise.resolve({ workspaces: [WorkspaceId(`ws-${request.directory}`)] })
  }

  /**
   * @param request - the rename.
   * @returns the plan, without changing anything.
   */
  planRename(request: RenameRequest): Promise<RenamePlan> {
    const found = this.workspaces.find(workspace => workspace.id === request.workspace) ?? this.workspaces[0]!
    return Promise.resolve({ workspace: found.id, from: found.title, to: request.name })
  }

  /**
   * @param request - the rename.
   * @returns the plan, recording the change.
   */
  async rename(request: RenameRequest): Promise<RenamePlan> {
    this.changes.push(['rename', request])
    return await this.planRename(request)
  }

  /**
   * @param request - the repository.
   * @returns the import's id and folder.
   */
  startImport(request: ImportRequest): Promise<{ readonly import: string, readonly directory: string }> {
    this.changes.push(['import', request])
    return Promise.resolve({ import: '00000000-0000-4000-8000-000000000003', directory: request.directory ?? 'site' })
  }

  /**
   * @param workspace - the workspace.
   * @returns its `AGENTS.md` from disk.
   */
  async instructions(workspace: WorkspaceId): Promise<InstructionsResponse> {
    const path = join(this.find(workspace).path, 'AGENTS.md')
    const text = await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    return { path, text, revision: revisionOf(text), maxBytes: 65_536 }
  }

  /** @param request - the workspace, text and revision. */
  async setInstructions(request: InstructionsRequest): Promise<void> {
    const current = await this.instructions(request.workspace)
    if (request.revision !== current.revision) throw new WorkspaceRefusedError('conflict', 'the file changed since it was read')
    this.changes.push(['instructions', request.workspace])
    if (request.text === '') await rm(current.path, { force: true })
    else await writeFile(current.path, request.text)
  }

  /**
   * @param request - the workspace.
   * @returns a trash entry.
   */
  trash(request: { readonly workspace: WorkspaceId }): Promise<TrashEntry> {
    this.changes.push(['trash', request])
    return Promise.resolve({ ...TRASHED, id: '00000000-0000-4000-8000-000000000004', directory: 'app' })
  }

  /**
   * @param request - the entry.
   * @returns the restored workspace.
   */
  restore(request: { readonly trash: string }): Promise<{ readonly workspaces: readonly WorkspaceId[] }> {
    this.changes.push(['restore', request])
    return Promise.resolve({ workspaces: [WorkspaceId('ws-old')] })
  }
}

/**
 * Make the fixture workspaces' folders under a root, each with its `AGENTS.md` when given.
 * @param root - an empty temporary directory.
 * @param files - each folder and its `AGENTS.md` text, or null for none.
 * @returns the workspaces.
 */
export async function makeWorkspaces(root: string, files: Readonly<Record<string, string | null>>): Promise<FixtureWorkspace[]> {
  const made: FixtureWorkspace[] = []
  for (const [folder, text] of Object.entries(files)) {
    const path = join(root, folder)
    await mkdir(path, { recursive: true })
    if (text !== null) await writeFile(join(path, 'AGENTS.md'), text)
    made.push({ id: WorkspaceId(`ws-${folder}`), path, title: folder })
  }
  return made
}
