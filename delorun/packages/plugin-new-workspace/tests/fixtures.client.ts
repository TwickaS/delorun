/** Test doubles the client specs share: the copy, a fake Host client and fake folder navigation. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { vi } from 'vitest'
import type { ApiResult, NewWorkspaceApi } from '../src/client/api.ts'
import { en, type Translate } from '../src/client/locales.ts'
import type { FolderBrowse, FolderListing } from '../src/client/screens/FolderScreen.tsx'
import type { PlacesAnswer, PreviewAnswer } from '../src/wire.ts'

/** This plugin's English copy. */
export const t: Translate = makeTranslate(en)

/** The home folder the specs run in. */
export const HOME = '/home/person'

/** A successful answer. */
export function ok<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

/** An answer that never came. */
export function failure(reason: 'locked' | 'refused-arrival' | 'failed'): ApiResult<never> {
  return { ok: false, reason }
}

/** Places with two recent workspaces and two suggested folders. */
export const PLACES: PlacesAnswer = {
  home: HOME,
  recent: [
    { path: `${HOME}/src/delorun`, name: 'delorun', kind: 'code', usedAt: '2026-11-15T12:00:00.000Z' },
    { path: `${HOME}/Documents/tax-2026`, name: 'tax-2026', kind: 'files', usedAt: '2026-11-10T12:00:00.000Z' },
  ],
  suggested: [{ path: `${HOME}/src`, name: 'src' }, { path: `${HOME}/Documents`, name: 'Documents' }],
  defaultParent: `${HOME}/Projects`,
}

/** The moment the specs treat as now: two days after the first recent workspace. */
export const NOW = Date.parse('2026-11-17T12:00:00.000Z')

/** A code project on the `main` branch with an `AGENTS.md`. */
export const CODE_PREVIEW: PreviewAnswer = {
  result: 'folder', kind: 'code', git: true, branch: 'main', agentsFile: true,
  entries: [{ name: 'apps', folder: true }, { name: 'docs', folder: true }, { name: 'README.md', folder: false }], more: true,
}

/**
 * One folder's listing as the studio gives it.
 * @param path - the folder.
 * @param names - the child folders' names; a dot-led name is hidden.
 * @param truncated - whether the list was cut.
 * @returns the listing, with the crumbs from the filesystem root.
 */
export function listingOf(path: string, names: readonly string[], truncated = false): FolderListing {
  const parts = path.split('/').filter(part => part !== '')
  const crumbs = [{ name: '/', path: '/' }, ...parts.map((part, index) => ({ name: part, path: `/${parts.slice(0, index + 1).join('/')}` }))]
  return { path, crumbs, entries: names.map(name => ({ name, path: `${path}/${name}`, hidden: name.startsWith('.') })), truncated }
}

/** The listings of a small home. */
export const LISTINGS: Readonly<Record<string, FolderListing>> = {
  [HOME]: listingOf(HOME, ['.config', 'Documents', 'src']),
  [`${HOME}/src`]: listingOf(`${HOME}/src`, ['delorun', 'site']),
  [`${HOME}/Documents`]: listingOf(`${HOME}/Documents`, []),
}

/** Fake folder navigation over fixed listings; an unlisted folder is empty. */
export function fakeBrowse(listings: Readonly<Record<string, FolderListing>> = LISTINGS) {
  const list = vi.fn(async (path?: string, _signal?: AbortSignal): Promise<FolderListing> => listings[path ?? HOME] ?? listingOf(path ?? HOME, []))
  const create = vi.fn(async (parent: string, name: string): Promise<string> => `${parent}/${name}`)
  const browse: FolderBrowse = { list, create }
  return { browse, list, create }
}

/** A Host client whose every route answers with a plausible success; each can be replaced, and every route is a spy. */
export function fakeApi(overrides: Partial<NewWorkspaceApi> = {}) {
  const spies = {
    places: vi.fn<NewWorkspaceApi['places']>(overrides.places ?? (async () => ok(PLACES))),
    search: vi.fn<NewWorkspaceApi['search']>(overrides.search ?? (async () => ok({ results: [], stopped: 'complete' as const }))),
    preview: vi.fn<NewWorkspaceApi['preview']>(overrides.preview ?? (async () => ok(CODE_PREVIEW))),
    add: vi.fn<NewWorkspaceApi['add']>(overrides.add ?? (async path => ok({ result: 'added' as const, workspaceId: 'workspace-1', path, kind: 'code' as const }))),
    create: vi.fn<NewWorkspaceApi['create']>(overrides.create ?? (async request => ok({ result: 'added' as const, workspaceId: 'workspace-2', path: `${request.parent}/${request.name}`, git: request.git }))),
    clone: vi.fn<NewWorkspaceApi['clone']>(overrides.clone ?? (async () => ok({ result: 'started' as const, job: 'job-1' }))),
    cloneStatus: vi.fn<NewWorkspaceApi['cloneStatus']>(overrides.cloneStatus ?? (async () => ok({ state: 'done' as const, workspaceId: 'workspace-3', path: `${HOME}/Projects/site`, kind: 'code' as const }))),
    defaults: vi.fn<NewWorkspaceApi['defaults']>(overrides.defaults ?? (async () => ok({ result: 'defaults' as const, defaults: {} }))),
    setDefaults: vi.fn<NewWorkspaceApi['setDefaults']>(overrides.setDefaults ?? (async (_path, defaults) => ok({ result: 'defaults' as const, defaults }))),
  }
  const api: NewWorkspaceApi = spies
  return { api, ...spies }
}
