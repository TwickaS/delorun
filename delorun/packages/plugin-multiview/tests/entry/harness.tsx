import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry, ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { vi } from 'vitest'
import { DEFAULT_MULTIVIEW_SETTINGS, type MultiviewSettings } from '../../src/config.ts'
import { MULTIVIEW_LAYER_ID, type ChatMultiview, type MultiviewService } from '../../src/client/contract.ts'
import { en } from '../../src/entry/locales.ts'
import { registerEntry } from '../../src/entry/register.ts'
import type { MultiviewStore } from '../../src/entry/state.ts'
import { memoryPersistence, sid } from './fixtures.ts'

/** One list row of a chat. */
function summary(id: string, options: { main?: boolean; running?: boolean; parent?: string } = {}) {
  return {
    id: sid(id), displayTitle: id, running: options.running ?? false, blank: false, updatedAt: 0,
    retainedBy: options.main === true ? { mainView: 1 } : {},
    ...options.parent === undefined ? {} : { origin: 'subagent' as const, parentId: sid(options.parent) },
  }
}

/** The session list a spec sets: which chat is the main view, and each chat's agent catalog. */
export interface ListSpec {
  readonly main?: string | undefined
  /** Catalogs by chat; a chat missing here has no projection read yet. */
  readonly catalogs?: Readonly<Record<string, readonly string[]>>
  readonly running?: readonly string[]
}

/** Build a session list snapshot. */
export function listOf(spec: ListSpec) {
  const byId: Record<string, ReturnType<typeof summary>> = {}
  const parentOfAgent = new Map<string, string>()
  for (const [chat, agents] of Object.entries(spec.catalogs ?? {})) for (const agent of agents) parentOfAgent.set(agent, chat)
  const ids = new Set<string>([...Object.keys(spec.catalogs ?? {}), ...parentOfAgent.keys(), ...(spec.main === undefined ? [] : [spec.main])])
  for (const id of ids) {
    byId[id] = summary(id, { main: id === spec.main, running: spec.running?.includes(id) ?? false, ...parentOfAgent.has(id) ? { parent: parentOfAgent.get(id)! } : {} })
  }
  const projectionsBySession = Object.fromEntries(Object.entries(spec.catalogs ?? {}).map(([chat, agents]) => [chat, {
    values: { subagentCatalog: agents.map(id => ({ id: sid(id), createdAt: 0, mode: 'subagent' })) }, state: 'ready', error: null,
  }]))
  return { ids: Object.keys(byId), byId, phase: 'ready', projectionsBySession }
}

/** The browser services the entry points use, recording what they are asked. */
export function harness(options: { settings?: Partial<MultiviewSettings> | undefined; layer?: boolean; initial?: Record<string, ChatMultiview>; list?: ListSpec; shortcuts?: boolean } = {}) {
  const ctx = new Context()
  const dictionaries = new Map<string, unknown>()
  ctx.provide('locale', {
    bind: () => makeTranslate(en),
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
  } as never)
  const entries = new Map<string, { component: unknown; inject?: () => unknown; order?: number }>()
  let layerRegistered = options.layer ?? true
  const slotListeners = new Set<() => void>()
  ctx.provide('slots', {
    inject: (_: string, register: () => (() => void) | Generator<() => void>) => {
      const result = register()
      if (typeof result === 'function') return result
      const disposers = [...result]
      return () => { for (const dispose of disposers) dispose() }
    },
    register: (slot: { name: string; id?: string; order?: number; inject?: () => unknown }, component: unknown) => {
      const key = `${slot.name}#${slot.id}`
      entries.set(key, { component, ...slot.inject === undefined ? {} : { inject: slot.inject }, ...slot.order === undefined ? {} : { order: slot.order } })
      return () => { entries.delete(key) }
    },
    subscribe: (_name: string, listener: () => void) => { slotListeners.add(listener); return () => { slotListeners.delete(listener) } },
    entries: (name: string) => (name === 'conversation.main.body' && layerRegistered ? [{ options: { id: MULTIVIEW_LAYER_ID } }] : []),
  } as never)
  const list = createSnapshotStore(listOf(options.list ?? {}))
  ctx.provide('sessions', { list } as never)
  const formListeners = new Set<() => void>()
  let formValue: Partial<MultiviewSettings> | undefined = options.settings === undefined ? undefined : { ...DEFAULT_MULTIVIEW_SETTINGS, ...options.settings }
  const formIds: string[] = []
  ctx.provide('configForms', {
    get: (id: string) => {
      formIds.push(id)
      return {
        getSnapshot: () => ({ status: formValue === undefined ? 'loading' : 'ready', value: formValue }),
        subscribe: (listener: () => void) => { formListeners.add(listener); return () => { formListeners.delete(listener) } },
      }
    },
  } as never)
  // The studio's keyboard registry, when the spec asks for one: the registered commands and a catalog the spec sets.
  const commands = new Map<string, ShortcutCommand>()
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([])
  if (options.shortcuts === true) {
    ctx.provide('shortcuts', {
      catalog,
      register: (command: ShortcutCommand) => {
        if (commands.has(command.id)) throw new Error(`duplicate command ${command.id}`)
        commands.set(command.id, command)
        return () => { commands.delete(command.id) }
      },
    } as never)
  }
  const persisted = memoryPersistence(options.initial)
  const warn = vi.fn()
  let store!: MultiviewStore
  const fiber = ctx.plugin({
    name: 'delorun-multiview',
    inject: ['slots', 'locale', 'sessions', 'configForms'],
    apply: (inner: Context) => {
      store = registerEntry(inner, { persistence: persisted.persistence, windowArea: () => ({ width: 4000, height: 3000 }) })
    },
  })
  return {
    ctx, fiber, dictionaries, entries, list, formIds, warn, commands, catalog, ...persisted,
    get store(): MultiviewStore { return store },
    get service(): MultiviewService { return store },
    setList: (spec: ListSpec) => { list.set(listOf(spec)) },
    setSettings: (value: Partial<MultiviewSettings>) => { formValue = { ...DEFAULT_MULTIVIEW_SETTINGS, ...value }; for (const listener of [...formListeners]) listener() },
    registerLayer: (value: boolean) => { layerRegistered = value; for (const listener of [...slotListeners]) listener() },
    state: (chat: string): ChatMultiview => store.of(sid(chat)).getSnapshot(),
    face: <T,>(key: string): T => {
      const entry = entries.get(key)
      if (entry?.inject === undefined) throw new Error(`no injected entry ${key}`)
      return entry.inject() as T
    },
  }
}

export type Harness = ReturnType<typeof harness>

/**
 * Slot props for a component under test: the props a spec gives, typed as the component's own.
 * @param given - the props the spec supplies; the rest of the slot's props are not read by the component.
 * @returns the props.
 */
export function slotProps<P extends object>(given: object): P {
  return Object.assign({} as P, given)
}
