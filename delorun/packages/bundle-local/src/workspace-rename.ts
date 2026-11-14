/**
 * The `delorun-workspace-rename` row of `@delorun/bundle-local`: the `rename_workspace` tool, which renames a workspace the
 * way the studio's rename does, so the agent never edits the registry file by hand. It checks the request first, asks
 * the person through upstream's approval service from inside the call (so no `tools/pre-execute` listener can let it
 * through unasked, and only `allowed-once` runs it), then renames through upstream's workspace registry
 * (`ctx.workspaceRegistry`), with the rules of the studio's rename: the new name is not blank and no other workspace
 * has it. The call and its result are ordinary session events.
 *
 * Every registration sits behind the C16 switch `rename_workspace_tool` ({@link Config.enabled}), off by default: off,
 * the plugin registers no tool, which is the parity value.
 *
 * @module @delorun/bundle-local/workspace-rename
 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { type Workspace } from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'

/** The plugin's name in the loader's diagnostics. */
export const name = 'delorun-workspace-rename'

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `rename_workspace_tool`: whether the plugin registers the `rename_workspace` tool. Off, the parity
   * value and the default, it registers nothing and the model has no tool for renaming a workspace. Delorun's composition
   * turns it on.
   */
  readonly enabled: boolean
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/** What a rename call returns: the names before and after, and whether anything changed. */
export interface RenameOutcome {
  /** The name before the call. */
  readonly from: string
  /** The name after the call. */
  readonly to: string
  /** False when the workspace already had that name. */
  readonly changed: boolean
}

/** The codes of {@link RenameToolError}. */
export type RenameToolErrorCode = 'WORKSPACE_RENAME_INVALID' | 'WORKSPACE_RENAME_REFUSED' | 'WORKSPACE_RENAME_DECLINED'

/** A rename that was not made, with a message that says what to do. */
export class RenameToolError extends HarnessError {
  /** Why. */
  override readonly code: RenameToolErrorCode

  /**
   * @param code - why.
   * @param message - what happened and what to do, for the agent.
   * @param options - the underlying failure as `cause`.
   */
  constructor(code: RenameToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** The arguments of a call: a workspace by id or current name, and the new name. */
const RenameRequest = zod.strictObject({
  workspace: zod.string().trim().min(1).max(200),
  name: zod.string().trim().min(1).max(200),
})

/** What a rename would change: the workspace, its name now and the name it would get. */
interface RenamePlan {
  /** The workspace. */
  readonly workspace: Workspace
  /** Its name now. */
  readonly from: string
  /** The name it would get. */
  readonly to: string
}

/**
 * Check a rename against the registry without changing anything.
 * @param ctx - the context with upstream's workspace registry.
 * @param request - the parsed arguments.
 * @returns what the rename would change.
 * @throws RenameToolError `WORKSPACE_RENAME_REFUSED` for an unknown or ambiguous workspace, or a name another workspace has.
 */
function plan(ctx: Context, request: zod.output<typeof RenameRequest>): RenamePlan {
  const registry = ctx.workspaceRegistry
  const wanted = request.workspace
  const byId = registry.list().find(candidate => candidate.id === wanted)
  const named = byId === undefined ? registry.list().filter(candidate => candidate.title === wanted) : [byId]
  if (named.length === 0) {
    throw new RenameToolError('WORKSPACE_RENAME_REFUSED', `Delorun refused it (not-found): no workspace has the id or name ${JSON.stringify(wanted)}`)
  }
  if (named.length > 1) {
    throw new RenameToolError('WORKSPACE_RENAME_REFUSED', `Delorun refused it (conflict): ${String(named.length)} workspaces are named ${JSON.stringify(wanted)}; name one by its id: ${named.map(candidate => candidate.id).join(', ')}`)
  }
  const workspace = named[0] as Workspace
  if (registry.list().some(candidate => candidate.id !== workspace.id && candidate.title === request.name)) {
    throw new RenameToolError('WORKSPACE_RENAME_REFUSED', `Delorun refused it (conflict): the name ${JSON.stringify(request.name)} is already in use by another workspace`)
  }
  return { workspace, from: workspace.title, to: request.name }
}

/**
 * The tool.
 * @param ctx - the plugin context with the workspace registry; the approval service is read when the call asks.
 * @returns the tool definition.
 */
export function renameWorkspaceTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'rename_workspace',
    description: 'Rename a workspace. Use it instead of editing any file to rename one. It asks the person first.',
    parameters: {
      workspace: { type: 'string', required: true, description: 'The workspace to rename, by its id or its current name.' },
      name: { type: 'string', required: true, description: 'The new name. It must not be blank or used by another workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true, description: 'The workspace\'s name before the call.' },
          to: { type: 'string', required: true, description: 'The workspace\'s name after the call.' },
          changed: { type: 'boolean', required: true, description: 'False when the workspace already had that name.' },
        },
      },
      render: (_args: unknown, value: RenameOutcome) => [{
        type: 'text' as const,
        text: value.changed
          ? `Renamed the workspace ${JSON.stringify(value.from)} to ${JSON.stringify(value.to)}.`
          : `The workspace is already named ${JSON.stringify(value.to)}.`,
      }],
      presentationMeta: (_args: unknown, value: RenameOutcome) => ({ from: value.from, to: value.to }),
    },
    async execute(args, exec) {
      const request = RenameRequest.safeParse(args)
      if (!request.success) {
        throw new RenameToolError('WORKSPACE_RENAME_INVALID', 'Give the workspace\'s id or current name, and a new name of 1 to 200 characters.')
      }
      const checked = plan(ctx, request.data)
      if (checked.from === checked.to) return { from: checked.from, to: checked.to, changed: false }
      const approval = ctx.get('approval')
      const outcome = approval === undefined || exec.agent === undefined
        ? 'unavailable'
        : await approval.request({
          agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
          reason: `${exec.name}: rename the workspace ${JSON.stringify(checked.from)} to ${JSON.stringify(checked.to)}.`,
          displayReason: {
            en: `The agent asks to rename the workspace ${JSON.stringify(checked.from)} to ${JSON.stringify(checked.to)}.`,
            zh: `智能体请求将工作区 ${JSON.stringify(checked.from)} 重命名为 ${JSON.stringify(checked.to)}。`,
          },
        })
      if (outcome !== 'allowed-once') {
        throw new RenameToolError('WORKSPACE_RENAME_DECLINED', `The person did not allow it (${outcome}), so nothing changed. Ask them in a reply instead.`)
      }
      // The person may have taken a while to answer; check again, as the studio's rename checks at its turn.
      const again = plan(ctx, { workspace: checked.workspace.id, name: checked.to })
      await again.workspace.setTitle(again.to)
      return { from: again.from, to: again.to, changed: true }
    },
    presentCall: args => ({ card: 'generic', title: `Rename the workspace ${args.workspace} to ${args.name}`, kind: 'other', rawInput: args }),
  })
}

/**
 * With the `rename_workspace_tool` switch on, register the `rename_workspace` tool. Off, register nothing.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  ctx.inject(['tools', 'workspaceRegistry'], (child) => {
    child.effect(() => child.tools.register(renameWorkspaceTool(child)), `${name}: rename_workspace`)
  })
}
