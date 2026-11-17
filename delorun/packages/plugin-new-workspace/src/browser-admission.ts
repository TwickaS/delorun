/**
 * The isolated browser's admission by workspace: the nearest workspace at or above a chat's folder with a stored browser
 * choice decides, and `none` means no browser server and refused browser tool calls; a chat under no choice is served.
 * The choices are held in memory, read once before the service is provided and again after each `.setDefaults` change,
 * because the admission is asked synchronously at each chat start and each browser tool call; a refresh reports each
 * live chat whose answer changed, so its server starts or stops at once.
 * @module @delorun/plugin-new-workspace/browser-admission
 */
import { dirname } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { workspaceKey } from '@delorun/plugin-permission-defaults/workspace'
import { readDefaultsStore } from './defaults-store.ts'
import { storePath, type DefaultsDeps } from './defaults.ts'
import { codeOf } from './location.ts'
import type { BrowserChoice } from './wire.ts'

/** What the browser server's mount asks, and the refresh after a change to the stored choices. */
export interface WorkspaceBrowserAdmission {
  /**
   * Whether a chat's browser server may serve it now.
   * @param agent - the chat's Agent.
   * @returns false when the nearest workspace at or above the chat's folder chose no browser, or the stored choices
   *   cannot be read; true otherwise.
   */
  admitted(agent: Pick<Agent, 'session'>): boolean
  /** Read the stored choices again, after a change to them, and report each live chat whose answer changed. */
  refresh(): Promise<void>
}

/** The choices as last read: each workspace's explicit browser choice by folder, or `unreadable`. */
type Held = { readonly kind: 'read', readonly choices: ReadonlyMap<string, BrowserChoice> } | { readonly kind: 'unreadable' }

/**
 * The answer for one chat's folder under the given choices.
 * @param held - the choices.
 * @param cwd - the chat's folder, if it has one.
 * @returns whether the chat is served.
 */
function verdict(held: Held, cwd: string | undefined): boolean {
  if (held.kind === 'unreadable') return false
  if (cwd === undefined || cwd.trim() === '') return true
  for (let folder = workspaceKey(cwd); ; folder = dirname(folder)) {
    const choice = held.choices.get(folder)
    if (choice !== undefined) return choice !== 'none'
    if (dirname(folder) === folder) return true
  }
}

/**
 * Create the admission and read the stored choices once.
 * @param deps - the environment and the log.
 * @param changed - told of each chat the admission was asked about whose answer a refresh changed; settles once the
 *   chat's browser server has started or stopped to match.
 * @returns the admission, with the choices read.
 */
export async function createBrowserAdmission(deps: DefaultsDeps, changed: (session: Agent['session']) => Promise<void>): Promise<WorkspaceBrowserAdmission> {
  let held: Held = { kind: 'read', choices: new Map() }
  // The chats asked about, held weakly so an ended chat is not kept alive.
  const asked = new Set<WeakRef<Agent['session']>>()
  const seen = new WeakSet<Agent['session']>()
  const read = async (): Promise<Held> => {
    const path = await storePath(deps)
    if (path === undefined) return { kind: 'unreadable' }
    try {
      const content = await readDefaultsStore(path)
      const choices = new Map<string, BrowserChoice>()
      for (const [key, defaults] of Object.entries(content.workspaces)) if (defaults.browser !== undefined) choices.set(key, defaults.browser)
      return { kind: 'read', choices }
    } catch (error) {
      // A store that exists but is refused may hold a "no browser" choice, so no chat is given the browser until it reads.
      deps.warn(`no chat gets the isolated browser, because the workspace browser choices were not read: ${codeOf(error)}`)
      return { kind: 'unreadable' }
    }
  }
  held = await read()
  return {
    admitted: (agent) => {
      if (!seen.has(agent.session)) {
        seen.add(agent.session)
        asked.add(new WeakRef(agent.session))
      }
      return verdict(held, agent.session.header.cwd)
    },
    refresh: async () => {
      const before = held
      held = await read()
      const reports: Promise<void>[] = []
      for (const ref of asked) {
        const session = ref.deref()
        if (session === undefined) asked.delete(ref)
        else if (verdict(before, session.header.cwd) !== verdict(held, session.header.cwd)) reports.push(changed(session))
      }
      await Promise.all(reports)
    },
  }
}
