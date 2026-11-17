/**
 * The isolated browser's admission by workspace: a chat whose folder is a workspace (or lies inside one) whose stored
 * browser choice is `none` gets no browser server, and its browser tool calls are refused. Every other chat is served.
 * The choices are held in memory, read once before the service is provided and again after each `.setDefaults` change,
 * because the admission is asked synchronously at each chat start and each browser tool call.
 * @module @delorun/plugin-new-workspace/browser-admission
 */
import { dirname } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { workspaceKey } from '@delorun/plugin-permission-defaults/workspace'
import { readDefaultsStore } from './defaults-store.ts'
import { storePath, type DefaultsDeps } from './defaults.ts'
import { codeOf } from './location.ts'

/** What the browser server's mount asks: the same members as the browser runtime's `SessionMcpAdmission`. */
export interface WorkspaceBrowserAdmission {
  /**
   * Whether a chat's browser server may serve it now.
   * @param agent - the chat's Agent.
   * @returns false when the chat's workspace chose no browser, or the stored choices cannot be read; true otherwise.
   */
  admitted(agent: Pick<Agent, 'session'>): boolean
  /**
   * Hear chats whose admission changed. A changed choice applies to the next chat; a running chat's browser calls are
   * refused from the change on, because the mount asks {@link WorkspaceBrowserAdmission.admitted} at each call.
   * @param listener - never called.
   * @returns the disposer.
   */
  changed(listener: (session: Agent['session']) => Promise<void>): () => void
  /** Read the stored choices again, after a change to them. */
  refresh(): Promise<void>
}

/** The choices as last read: the folders whose chats get no browser, or `unreadable`. */
type Held = { readonly kind: 'read', readonly none: ReadonlySet<string> } | { readonly kind: 'unreadable' }

/**
 * Create the admission and read the stored choices once.
 * @param deps - the environment and the log.
 * @returns the admission, with the choices read.
 */
export async function createBrowserAdmission(deps: DefaultsDeps): Promise<WorkspaceBrowserAdmission> {
  let held: Held = { kind: 'read', none: new Set() }
  const refresh = async (): Promise<void> => {
    const path = await storePath(deps)
    if (path === undefined) {
      held = { kind: 'unreadable' }
      return
    }
    try {
      const content = await readDefaultsStore(path)
      held = { kind: 'read', none: new Set(Object.entries(content.workspaces).filter(([, defaults]) => defaults.browser === 'none').map(([key]) => key)) }
    } catch (error) {
      // A store that exists but is refused may hold a "no browser" choice, so no chat is given the browser until it reads.
      deps.warn(`no chat gets the isolated browser, because the workspace browser choices were not read: ${codeOf(error)}`)
      held = { kind: 'unreadable' }
    }
  }
  await refresh()
  return {
    admitted: (agent) => {
      if (held.kind === 'unreadable') return false
      const cwd = agent.session.header.cwd
      if (cwd === undefined || cwd.trim() === '') return true
      for (let folder = workspaceKey(cwd); ; folder = dirname(folder)) {
        if (held.none.has(folder)) return false
        if (dirname(folder) === folder) return true
      }
    },
    changed: () => () => {},
    refresh,
  }
}
