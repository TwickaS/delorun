/**
 * Where the studio's first-use workspace goes when `delorun start` boots a CLI profile: `<base>/Delo/default-workspace`,
 * where the base is the platform's documents folder when its lookup reports one other than the home directory, and
 * the home directory otherwise. Upstream's own lookup gives up where the platform reports no documents folder, as on
 * Linux and WSL without an XDG Documents folder, and then the studio has no default workspace.
 *
 * The step holds each candidate against the folders no workspace may be ([workspace location](../../../packages/home/src/workspace-location.ts))
 * and against the OS temporary directory, which Windows confinement refuses inside a workspace root, and uses the
 * first one held clear. It creates nothing: upstream's registry creates the folder when the studio first asks for the
 * default workspace. The start hands the result to `@delo/bundle-local`'s `workspace-controller` row through
 * {@link DEFAULT_WORKSPACE_ENV}.
 *
 * @module @delo/cli/default-workspace
 */
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix, sep, win32 } from 'node:path'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { DEFAULT_WORKSPACE_ENV } from '@delo/bundle-local/profile'
import { workspaceLocationHomes, workspaceLocationMessage, workspaceLocationProblem, type WorkspaceLocationHomes, type WorkspaceLocationProblem } from '@delo/home'
import { CliError, EXIT } from './exit.ts'

export { DEFAULT_WORKSPACE_ENV }

/** The id of upstream's workspace controller row, which `@delo/bundle-local` configures. */
export const WORKSPACE_CONTROLLER_ROW = 'workspace-controller'

/**
 * The folders below the base. The last segment is upstream's `DEFAULT_WORKSPACE_DIRECTORY`: the registry takes the
 * initial title from it, and the studio shows that title as the localized "Default workspace".
 */
export const DEFAULT_WORKSPACE_SEGMENTS = ['Delo', 'default-workspace'] as const

/** How long the documents lookup may run, as upstream's `documentsLookupTimeoutMs` default. */
export const DOCUMENTS_LOOKUP_TIMEOUT_MS = 10_000

/** Each platform's documents lookup, the commands upstream's workspace controller runs. */
const DOCUMENTS_COMMANDS: Partial<Record<NodeJS.Platform, readonly [string, readonly string[]]>> = {
  darwin: ['osascript', ['-e', 'POSIX path of (path to documents folder from user domain without folder creation)']],
  win32: ['powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
    + '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, '
    + '[Environment+SpecialFolderOption]::DoNotVerify)',
  ]],
  linux: ['xdg-user-dir', ['DOCUMENTS']],
}

/**
 * Ask the platform for the person's documents folder, as upstream's workspace controller asks.
 * @param platform - the operating system.
 * @param timeoutMs - how long the command may run before it is stopped.
 * @param run - the command runner; upstream's no-shell runner by default.
 * @returns the reported folder as printed, without its trailing line break; `undefined` on a platform with no lookup,
 *   when the command is missing, fails or times out, or when it prints nothing.
 */
export async function lookupDocumentsDirectory(platform: NodeJS.Platform, timeoutMs: number, run: NativeCommandRunner = runNativeCommand): Promise<string | undefined> {
  const command = DOCUMENTS_COMMANDS[platform]
  if (command === undefined) return undefined
  let stdout: string
  try {
    ({ stdout } = await run(command[0], command[1], AbortSignal.timeout(timeoutMs), 'hidden'))
  } catch (_noLookup) {
    // A missing command, a failure and the timeout all mean the platform reports no documents folder: the home is used.
    return undefined
  }
  const directory = stdout.replace(/[\r\n]+$/u, '')
  return directory === '' ? undefined : directory
}

/** What the resolution reads. */
export interface DefaultWorkspaceRequest {
  /** The operating system, which decides the path syntax and the case rule of comparisons. */
  readonly platform: NodeJS.Platform
  /** The person's home directory, the Delo home and upstream's stock home. */
  readonly homes: WorkspaceLocationHomes
  /** The OS temporary directory, which Windows confinement refuses inside a workspace root. */
  readonly tempDirectory: string
  /** The profile's own `cordis.patch.yml`, which the failure names as the place to choose the folder. */
  readonly profilePatchPath: string
  /**
   * Whether that patch configures the `workspace-controller` row. Its `config` then replaces the bundle's, so the
   * person's setting applies and nothing is resolved.
   */
  readonly profileConfiguresRow: boolean
  /** The documents lookup, such as {@link lookupDocumentsDirectory}. */
  readonly documents: () => Promise<string | undefined>
}

/** Which folder the default workspace lies under. */
export type DefaultWorkspaceBase = 'documents' | 'home'

/** The resolution's result. */
export type DefaultWorkspaceSpec =
  /** The profile's own patch configures the row; the start sets nothing. */
  | { readonly kind: 'profile' }
  /** The folder the start hands to the bundle's row, absolute and not created by the resolution. */
  | { readonly kind: 'resolved'; readonly directory: string; readonly base: DefaultWorkspaceBase }

/** Why a candidate folder cannot be the default workspace. */
type CandidateProblem = WorkspaceLocationProblem | 'contains-temp-directory'

/**
 * Compare paths as the platform's default filesystem does: without case on Windows and macOS.
 * @param path - an absolute path.
 * @param platform - the operating system.
 * @returns the comparison key.
 */
function comparable(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? path.toLowerCase() : path
}

/**
 * The real path of an existing folder.
 * @param path - the folder.
 * @returns its real path, or `undefined` when it does not exist.
 */
async function existing(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (_missing) {
    // A folder that does not exist holds nothing, the temporary directory included.
    return undefined
  }
}

/**
 * Whether a folder holds the OS temporary directory. A folder not created yet holds nothing.
 * @param directory - the candidate.
 * @param request - the temporary directory and the platform.
 * @returns true when the temporary directory is the folder or lies inside it.
 */
async function containsTempDirectory(directory: string, request: DefaultWorkspaceRequest): Promise<boolean> {
  const [folder, temp] = await Promise.all([existing(directory), existing(request.tempDirectory)])
  if (folder === undefined || temp === undefined) return false
  // Real paths are in this host's syntax, and a candidate is never a filesystem root, so it ends in no separator.
  const base = comparable(folder, request.platform)
  const inner = comparable(temp, request.platform)
  return inner === base || inner.startsWith(base + sep)
}

/**
 * Hold a candidate against the folders no workspace may be, then against the temporary directory.
 * @param directory - the candidate.
 * @param request - the homes, the temporary directory and the platform.
 * @returns the first problem, or `undefined` when the folder may be the default workspace.
 */
async function candidateProblem(directory: string, request: DefaultWorkspaceRequest): Promise<CandidateProblem | undefined> {
  const problem = await workspaceLocationProblem(directory, request.homes)
  if (problem !== undefined) return problem
  return await containsTempDirectory(directory, request) ? 'contains-temp-directory' : undefined
}

/**
 * The sentence that names a candidate's problem.
 * @param problem - the problem.
 * @returns one sentence.
 */
function problemMessage(problem: CandidateProblem): string {
  return problem === 'contains-temp-directory'
    ? 'This folder contains the temporary folder, which Windows confinement refuses inside a workspace; choose or create a folder elsewhere.'
    : workspaceLocationMessage(problem)
}

/**
 * Resolve the folder of the studio's first-use workspace: `<documents>/Delo/default-workspace` when the lookup reports
 * a documents folder other than the home directory and that folder is held clear, otherwise
 * `<home>/Delo/default-workspace` when it is held clear. Nothing is created.
 * @param request - the platform, homes, temporary directory, profile patch and documents lookup.
 * @returns `profile` when the profile's own patch configures the row, otherwise the resolved folder and its base.
 * @throws {CliError} when every candidate is refused, naming each candidate's reason and the row setting that chooses
 *   the folder instead.
 */
export async function resolveDefaultWorkspace(request: DefaultWorkspaceRequest): Promise<DefaultWorkspaceSpec> {
  if (request.profileConfiguresRow) return { kind: 'profile' }
  const { platform, homes } = request
  const paths = platform === 'win32' ? win32 : posix
  const documents = await request.documents()
  const candidates: { readonly base: DefaultWorkspaceBase, readonly directory: string }[] = []
  // `relative` folds `.`, `..` and trailing separators, so two spellings of the home compare equal.
  if (documents !== undefined && paths.relative(comparable(homes.osHome, platform), comparable(documents, platform)) !== '') {
    candidates.push({ base: 'documents', directory: paths.join(documents, ...DEFAULT_WORKSPACE_SEGMENTS) })
  }
  candidates.push({ base: 'home', directory: paths.join(homes.osHome, ...DEFAULT_WORKSPACE_SEGMENTS) })
  const refusals: string[] = []
  for (const candidate of candidates) {
    const problem = await candidateProblem(candidate.directory, request)
    if (problem === undefined) return { kind: 'resolved', ...candidate }
    refusals.push(`${candidate.directory}: ${problemMessage(problem)}`)
  }
  throw new CliError(EXIT.failed, [
    'delorun: Delo found no folder for the default workspace.',
    ...refusals,
    `Choose one in ${request.profilePatchPath}: add the row \`- id: ${WORKSPACE_CONTROLLER_ROW}\` with \`config: { defaultWorkspaceDirectory: <a folder of your own> }\`, then start again.`,
  ].join('\n'))
}

/**
 * Whether a profile's own patch configures the `workspace-controller` row.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @returns true when an entry with that id carries a `config`.
 * @throws Error when the patch cannot be read or parsed, as upstream's boot would fail on it.
 */
export function profileConfiguresWorkspaceRow(patchPath: string): boolean {
  return loadOverlayPatches('delorun', patchPath).some(entry => entry.id === WORKSPACE_CONTROLLER_ROW && entry.config !== undefined)
}

/**
 * The request of a start: this process's platform and homes, the OS temporary directory, the profile's own patch and
 * upstream's documents lookup with {@link DOCUMENTS_LOOKUP_TIMEOUT_MS}.
 * @param deloHome - the resolved Delo home.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @returns the request.
 */
export function defaultWorkspaceRequest(deloHome: string, patchPath: string): DefaultWorkspaceRequest {
  return {
    platform: process.platform,
    homes: workspaceLocationHomes(deloHome),
    tempDirectory: tmpdir(),
    profilePatchPath: patchPath,
    profileConfiguresRow: profileConfiguresWorkspaceRow(patchPath),
    documents: () => lookupDocumentsDirectory(process.platform, DOCUMENTS_LOOKUP_TIMEOUT_MS),
  }
}
