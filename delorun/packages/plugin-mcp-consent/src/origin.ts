/**
 * Where an MCP server's definition lives (A631, L201), judged from the plugins that mounted the server's mcp-client
 * (the Loader rows whose subtree holds the client's fiber) and from the patch layer that added or changed each of those
 * rows ([layers](./layers.ts)). The server's name, command and configuration never take part, so a server a plugin or a
 * bundle brings cannot pass for a pack's or the person's by naming itself after one.
 *
 * @module @delorun/plugin-mcp-consent/origin
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Entry as LoaderEntry } from '@deepseek-ai/cordis-plugin-loader'
import McpServerManager from '@deepseek-ai/dsh-mcp-manager'
import type { RowLayer, RowSources } from './layers.ts'
import type { ServerOrigin } from './wire.ts'

/** The module of the agent loop, which runs a chat's own setup; an editor's ACP session mounts its servers there. */
const AGENT_LOOP_MODULE = '@deepseek-ai/dsh-agent-loop'

/**
 * The Loader rows whose subtree holds a fiber, nearest first, each with its topmost fiber: a plugin a row's plugin
 * mounts inherits the row, and a group row's children sit under the group's.
 * @param fiber - the fiber.
 * @returns the rows; empty when no row owns the fiber.
 */
function owningRows(fiber: Fiber): readonly { readonly entry: LoaderEntry; readonly root: Fiber }[] {
  const rows: { entry: LoaderEntry; root: Fiber }[] = []
  let current = fiber
  for (;;) {
    const entry = current.entry
    if (entry !== undefined) {
      const last = rows.at(-1)
      if (last?.entry === entry) last.root = current
      else rows.push({ entry, root: current })
    }
    const next = current.parent.fiber
    if (next === current) return rows
    current = next
  }
}

/**
 * The first third-party bundle that added or changed a row.
 * @param layers - the row's layers.
 * @returns the bundle's name, or `undefined` when only Delorun's runtime bundles and packs touch the row.
 */
function thirdParty(layers: readonly RowLayer[] | undefined): string | undefined {
  return layers?.find(layer => layer.kind === 'other')?.bundle
}

/**
 * Judge where a server's definition lives from the context of the mcp-client plugin that starts it.
 * - a third-party bundle added or changed the client's row or any row around it: `plugin`, named by the bundle;
 * - a pack the release installs inserted the nearest row: `pack`;
 * - the client is a row the person's own patch file inserts and no bundle touches: `profile`; a row of any other
 *   source is `unknown`;
 * - the MCP manager's row (its plugin class, not its module name), from Delorun's runtime bundles or the person's file,
 *   mounted it: `settings` for a server of its configured list, `plugin` for a registered one, whose registering plugin
 *   the manager does not record;
 * - the agent loop mounted it inside a chat's setup: `chat`;
 * - any other plugin: `plugin`, named by its module; no owning row: `unknown`.
 * Without row sources (no profile context, or files that do not read) nothing counts as the person's, Settings' or a
 * pack's.
 * @param client - the mcp-client plugin's context.
 * @param serverName - the server's configured name, used only to ask the MCP manager whether it is in its list.
 * @param manager - the MCP manager the consent sees, if any.
 * @param sources - where the running profile's rows come from, read for this review.
 * @returns the origin.
 */
export function originOf(client: Context, serverName: string, manager: Context['mcpManager'] | undefined, sources: RowSources | undefined): ServerOrigin {
  const rows = owningRows(client.fiber)
  const row = rows[0]
  if (row === undefined) return { kind: 'unknown' }
  for (const each of rows) {
    const bundle = thirdParty(sources?.bundles.get(each.entry.options.id))
    if (bundle !== undefined) return { kind: 'plugin', plugin: bundle }
  }
  const id = row.entry.options.id
  const plugin = row.entry.options.name
  const layers = sources?.bundles.get(id)
  const pack = layers?.find(layer => layer.kind === 'pack' && layer.inserts)
  if (pack !== undefined) return { kind: 'pack', pack: pack.bundle, plugin }
  if (row.root === client.fiber) return sources?.own.has(id) === true && layers === undefined ? { kind: 'profile' } : { kind: 'unknown' }
  if (row.root.runtime?.callback === McpServerManager) {
    const trusted = sources !== undefined && (sources.own.has(id) || layers?.some(layer => layer.kind === 'runtime' && layer.inserts) === true)
    const listed = manager?.list().find(server => server.name === serverName)
    return trusted && listed?.configured === true && manager?.registered(serverName) !== true ? { kind: 'settings' } : { kind: 'plugin', plugin }
  }
  if (plugin === AGENT_LOOP_MODULE) return { kind: 'chat' }
  return { kind: 'plugin', plugin }
}
