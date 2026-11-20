import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { DEFAULT_MULTIVIEW_SETTINGS, type MultiviewSettings } from '../../src/config.ts'
import type { ChatMultiview, MultiviewPersistence } from '../../src/client/contract.ts'
import { MultiviewStore } from '../../src/entry/state.ts'

export const sid = (value: string): SessionId => SessionId(value)
export const CHAT = sid('chat')
export const A = sid('agent-a')
export const B = sid('agent-b')
export const C = sid('agent-c')

/** A persistence kept in memory that records every save. */
export function memoryPersistence(initial: Record<string, ChatMultiview> = {}) {
  const saved = new Map<string, ChatMultiview>(Object.entries(initial))
  const saves: Array<{ chat: string; value: ChatMultiview; keepChats: number }> = []
  const persistence: MultiviewPersistence = {
    load: chat => saved.get(chat),
    save: (chat, value, keepChats) => { saved.set(chat, value); saves.push({ chat, value, keepChats }) },
  }
  return { persistence, saved, saves }
}

/** A settings source whose value a spec replaces, as the settings form does. */
export function settingsSource(initial: Partial<MultiviewSettings> = {}) {
  const store = createSnapshotStore<MultiviewSettings>({ ...DEFAULT_MULTIVIEW_SETTINGS, ...initial })
  return { settings: store, change: (next: Partial<MultiviewSettings>) => { store.set({ ...store.getSnapshot(), ...next }) } }
}

/** A store over memory, a huge window, and a recorder of what the panel is told to show. */
export function makeStore(options: { settings?: Partial<MultiviewSettings>; initial?: Record<string, ChatMultiview>; window?: { width: number; height: number } } = {}) {
  const { persistence, saved, saves } = memoryPersistence(options.initial)
  const source = settingsSource(options.settings)
  const shown: Array<{ chat: string; open: boolean }> = []
  const store = new MultiviewStore({
    settings: source.settings,
    persistence,
    show: (chat, open) => { shown.push({ chat, open }) },
    windowArea: () => options.window ?? { width: 4000, height: 3000 },
  })
  return { store, saved, saves, shown, ...source }
}
