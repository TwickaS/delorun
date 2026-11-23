/**
 * Where an MCP server's definition lives (A631), judged from the plugins that mounted the server's mcp-client: the
 * Loader row whose subtree holds the client's fiber. The server's name, command and configuration never take part, so a
 * server a plugin brings cannot pass for a pack's or the person's by naming itself after one.
 *
 * @module @delorun/plugin-mcp-consent/origin
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Entry as LoaderEntry } from '@deepseek-ai/cordis-plugin-loader'
import McpServerManager from '@deepseek-ai/dsh-mcp-manager'
import { PACK_PLUGINS } from './pack-plugins.ts'
import type { ServerOrigin } from './wire.ts'

/** The module of the agent loop, which runs a chat's own setup; an editor's ACP session mounts its servers there. */
const AGENT_LOOP_MODULE = '@deepseek-ai/dsh-agent-loop'

/**
 * The Loader row whose subtree holds a fiber, with the row's own fiber: a plugin a row's plugin mounts inherits the
 * row, so the walk goes up to the topmost fiber of that row.
 * @param fiber - the fiber.
 * @returns the row and its fiber, or `undefined` when no row owns the fiber.
 */
function owningRow(fiber: Fiber): { readonly entry: LoaderEntry; readonly root: Fiber } | undefined {
  let current = fiber
  while (current.entry === undefined) {
    const next = current.parent.fiber
    if (next === current) return undefined
    current = next
  }
  const entry = current.entry
  for (let next = current.parent.fiber; next !== current && next.entry === entry; next = current.parent.fiber) current = next
  return { entry, root: current }
}

/**
 * Judge where a server's definition lives from the context of the mcp-client plugin that starts it.
 * - the client is a Loader row itself: `profile`, a row of the profile's configuration;
 * - the MCP manager's row (its plugin class, not its module name) mounted it: `settings` for a server of its configured list, `plugin` for a registered one, whose
 *   registering plugin the manager does not record;
 * - a pack plugin ({@link PACK_PLUGINS}) mounted it: `pack`;
 * - the agent loop mounted it inside a chat's setup: `chat`;
 * - any other plugin: `plugin`, named by its module; no owning row: `unknown`.
 * @param client - the mcp-client plugin's context.
 * @param serverName - the server's configured name, used only to ask the MCP manager whether it is in its list.
 * @param manager - the MCP manager the consent sees, if any.
 * @param packs - the pack plugins by module; Delorun's own unless a test names others.
 * @returns the origin.
 */
export function originOf(client: Context, serverName: string, manager: Context['mcpManager'] | undefined, packs: ReadonlyMap<string, string> = PACK_PLUGINS): ServerOrigin {
  const row = owningRow(client.fiber)
  if (row === undefined) return { kind: 'unknown' }
  if (row.root === client.fiber) return { kind: 'profile' }
  const plugin = row.entry.options.name
  if (row.root.runtime?.callback === McpServerManager) {
    const listed = manager?.list().find(server => server.name === serverName)
    return listed?.configured === true && manager?.registered(serverName) !== true ? { kind: 'settings' } : { kind: 'plugin', plugin }
  }
  const pack = packs.get(plugin)
  if (pack !== undefined) return { kind: 'pack', pack, plugin }
  if (plugin === AGENT_LOOP_MODULE) return { kind: 'chat' }
  return { kind: 'plugin', plugin }
}
