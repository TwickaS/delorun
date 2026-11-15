/**
 * What the guide's steps share while the dialog is open: this computer's readiness, the key tests, the plugins'
 * connections, the chosen workspace and a running clone, each a store a step subscribes to, so a step that is left and
 * shown again finds them as they were. Readiness and the key tests are read once when the dialog opens; the
 * recommendations when the plugins step first shows, and from the registry only when the person asks.
 * @module @delorun/plugin-onboarding/client/guide
 */
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CloneFailure, CloneProblem, CloneRequest, FolderKind, KeyTestAnswer, Readiness, RecommendAnswer } from '../wire.ts'
import type { AddedFolder, HostFace } from './types.ts'

/** A value read from the harness: still loading, read, or not readable. */
export type Loadable<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'failed' }

/** The workspace the first chat opens in: the default workspace, or a folder the Workspace step added or cloned. */
export type WorkspaceChoice =
  | { readonly kind: 'default'; readonly workspaceId: WorkspaceId; readonly path: string }
  | ({ readonly kind: 'added' } & AddedFolder)

/** How the Workspace step finds the folder: the default workspace, a folder on this computer, or a clone from Git. */
export type WorkspaceMode = 'default' | 'folder' | 'clone'

/** Where a clone the Workspace step started stands; a finished clone becomes the chosen workspace and this returns to `idle`. */
export type CloneView =
  | { readonly state: 'idle' }
  | { readonly state: 'starting' }
  | { readonly state: 'running'; readonly percent?: number }
  | { readonly state: 'refused'; readonly problem: CloneProblem }
  /** `failed` also covers a harness that could not be asked or no longer knows the clone. */
  | { readonly state: 'failed'; readonly failure: CloneFailure }

/** How often a running clone is asked where it stands, in milliseconds. */
export const CLONE_POLL_MS = 1000

/** Where the providers step stands: the cards, the walk through the ticked providers, or the summary. */
export type ProvidersPhase = 'landing' | 'walk' | 'summary'

/** What the person did on Phone access: nothing yet, Not now, "I've done this" while reach reads off, or reach found on. */
export type PhoneOutcome = 'untouched' | 'skipped' | 'done' | 'on'

/** A read-only store. */
export interface Store<T> {
  /** @returns the current value. */
  getSnapshot(): T
  /**
   * @param listener - called after each change.
   * @returns the unsubscriber.
   */
  subscribe(listener: () => void): () => void
}

/**
 * A hold on Continue that a step registers while it has something unfinished: it returns true to let the flow go on
 * and false (or a promise of it) to stay on the step, having shown the person why.
 */
export type ContinueGate = () => boolean | Promise<boolean>

/** The guide's shared state. */
export interface Guide {
  /** This computer's readiness. */
  readonly readiness: Store<Loadable<Readiness>>
  /** Each model provider's key test. */
  readonly keys: Store<Loadable<KeyTestAnswer>>
  /** Which connections each recommended plugin is for; absent until the plugins step asks. */
  readonly recommendations: Store<Loadable<RecommendAnswer> | undefined>
  /** The chosen workspace; undefined until one is chosen or the default resolves. */
  readonly workspace: Store<WorkspaceChoice | undefined>
  /** How the Workspace step finds the folder; `default` until the person picks another way. */
  readonly mode: Store<WorkspaceMode>
  /** The Workspace step's clone. */
  readonly clone: Store<CloneView>
  /** Where the providers step stands, which decides the dialog's own buttons. */
  readonly providersPhase: Store<ProvidersPhase>
  /** What the person did on Phone access, which Ready reports. */
  readonly phone: Store<PhoneOutcome>
  /**
   * @param outcome - what the person did on Phone access.
   */
  setPhone(outcome: PhoneOutcome): void
  /**
   * @param phase - where the providers step stands now.
   */
  setProvidersPhase(phase: ProvidersPhase): void
  /**
   * Hold Continue while a step has something unfinished.
   * @param key - the step's own name for the hold.
   * @param gate - the hold, or undefined to release it.
   */
  setGate(key: string, gate: ContinueGate | undefined): void
  /**
   * Ask every hold, in the order set, whether Continue may go on.
   * @returns whether the flow may go on; false as soon as one hold refuses.
   */
  passGates(): Promise<boolean>
  /** Test the keys again, as after the person changed a provider. */
  testKeys(): void
  /**
   * Read the recommended plugins' connections.
   * @param registry - whether to read packages that are not installed from the registry.
   */
  recommend(registry: boolean): void
  /**
   * Choose the workspace the first chat opens in.
   * @param choice - the workspace.
   */
  chooseWorkspace(choice: WorkspaceChoice): void
  /**
   * @param mode - how the Workspace step finds the folder.
   */
  setMode(mode: WorkspaceMode): void
  /**
   * Clone a repository into a new folder and, once Git finishes and the folder is added, choose it. Nothing starts
   * while a clone runs.
   * @param request - the address, the folder to clone into and the new folder's name.
   */
  startClone(request: CloneRequest): void
  /** Stop asking about a running clone, as when the dialog closes; the clone itself runs on in the harness. */
  dispose(): void
}

/**
 * Load a value into a store, `loading` until it settles.
 * @param store - the store.
 * @param load - the read; `undefined` means it could not be read.
 */
function fill<T>(store: { set(value: Loadable<T>): void }, load: () => Promise<T | undefined>): void {
  store.set({ status: 'loading' })
  void load().then((value) => { store.set(value === undefined ? { status: 'failed' } : { status: 'ready', value }) })
}

/**
 * Create the guide's state and start reading readiness and the key tests.
 * @param host - the harness's routes.
 * @param pollMs - how often a running clone is asked where it stands.
 * @returns the state.
 */
export function createGuide(host: HostFace, pollMs: number = CLONE_POLL_MS): Guide {
  const readiness = createSnapshotStore<Loadable<Readiness>>({ status: 'loading' })
  const keys = createSnapshotStore<Loadable<KeyTestAnswer>>({ status: 'loading' })
  const recommendations = createSnapshotStore<Loadable<RecommendAnswer> | undefined>(undefined)
  const workspace = createSnapshotStore<WorkspaceChoice | undefined>(undefined)
  const mode = createSnapshotStore<WorkspaceMode>('default')
  const clone = createSnapshotStore<CloneView>({ state: 'idle' })
  const providersPhase = createSnapshotStore<ProvidersPhase>('landing')
  const phone = createSnapshotStore<PhoneOutcome>('untouched')
  const gates = new Map<string, ContinueGate>()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = (job: string): void => {
    timer = setTimeout(() => {
      void host.cloneStatus(job).then((status) => {
        if (disposed) return
        switch (status.state) {
          case 'running':
            clone.set(status.percent === undefined ? { state: 'running' } : { state: 'running', percent: status.percent })
            poll(job)
            return
          case 'done':
            clone.set({ state: 'idle' })
            workspace.set({ kind: 'added', workspaceId: status.workspaceId as WorkspaceId, path: status.path, folder: status.kind })
            return
          case 'failed':
            clone.set({ state: 'failed', failure: status.failure })
            return
          case 'unknown':
            clone.set({ state: 'failed', failure: 'failed' })
            return
          /* v8 ignore next 2 -- closed-union default only defends a future widening of CloneStatus */
          default:
            assertNever(status)
        }
      })
    }, pollMs)
  }
  fill(readiness, host.readiness)
  fill(keys, host.keyTest)
  return {
    readiness, keys, recommendations, workspace, mode, clone, providersPhase, phone,
    setPhone: (outcome) => { phone.set(outcome) },
    setProvidersPhase: (phase) => { providersPhase.set(phase) },
    setGate: (key, gate) => { if (gate === undefined) gates.delete(key); else gates.set(key, gate) },
    passGates: async () => {
      for (const gate of [...gates.values()]) {
        if (!await gate()) return false
      }
      return true
    },
    testKeys: () => { fill(keys, host.keyTest) },
    recommend: (registry) => { fill(recommendations, () => host.recommend(registry)) },
    chooseWorkspace: (choice) => { workspace.set(choice) },
    setMode: (next) => { mode.set(next) },
    startClone: (request) => {
      const now = clone.getSnapshot().state
      if (now === 'starting' || now === 'running') return
      clone.set({ state: 'starting' })
      void host.cloneStart(request).then((outcome) => {
        if (disposed) return
        if (outcome.kind === 'started') {
          clone.set({ state: 'running' })
          poll(outcome.job)
        } else {
          clone.set(outcome.kind === 'refused' ? { state: 'refused', problem: outcome.problem } : { state: 'failed', failure: 'failed' })
        }
      })
    },
    dispose: () => {
      disposed = true
      clearTimeout(timer)
    },
  }
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when CloneStatus widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled clone status ${JSON.stringify(value)}`)
}

/** The coding agents a sign-in is read for, by connection id. */
const AGENT_IDS = ['claude-code', 'codex'] as const

/**
 * The connections this computer has, as `CONNECTION_ID`s: each model provider route the key test lists, each coding
 * agent with a sign-in found, and Tailscale once it is installed.
 * @param keys - the key tests.
 * @param readiness - this computer's readiness.
 * @returns the connection ids.
 */
export function presentConnections(keys: Loadable<KeyTestAnswer>, readiness: Loadable<Readiness>): readonly string[] {
  const ids: string[] = []
  if (keys.status === 'ready') ids.push(...keys.value.providers.map(each => `provider:${each.provider}`))
  if (readiness.status === 'ready') {
    ids.push(...AGENT_IDS.filter(id => readiness.value.agents[id] === 'found').map(id => `agent:${id}`))
    const tailscale = readiness.value.tailscale.state
    if (tailscale !== 'not-installed' && tailscale !== 'unknown') ids.push('tool:tailscale')
  }
  return ids
}

/** What the plugins step shows for one plugin: the connections of the person's it fits, or that it fits any setup. */
export interface Fit {
  readonly name: string
  /** The present connections it declares; empty for a plugin that declares none or could not be read. */
  readonly matches: readonly string[]
}

/**
 * Order the recommended plugins: those that fit a present connection first, then those that need none. A plugin that
 * declares only connections the person does not have is left out.
 * @param names - the configured plugins, in order.
 * @param answer - their connections, when read.
 * @param present - the person's connections.
 * @returns the plugins to show, in order.
 */
export function fits(names: readonly string[], answer: RecommendAnswer | undefined, present: readonly string[]): readonly Fit[] {
  const declared = new Map(answer?.plugins.map(each => [each.name, each.connections]) ?? [])
  const shown = names.map((name): Fit | undefined => {
    const connections = declared.get(name) ?? []
    if (connections.length === 0) return { name, matches: [] }
    const matches = connections.filter(id => present.includes(id))
    return matches.length === 0 ? undefined : { name, matches }
  }).filter((each): each is Fit => each !== undefined)
  return [...shown.filter(each => each.matches.length > 0), ...shown.filter(each => each.matches.length === 0)]
}

/**
 * @param choice - the chosen workspace.
 * @returns what its folder holds, when the Workspace step read it.
 */
export function folderOf(choice: WorkspaceChoice | undefined): FolderKind | undefined {
  return choice?.kind === 'added' ? choice.folder : undefined
}
