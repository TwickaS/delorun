/**
 * The `rename_workspace` tool: renames a workspace the way the studio's rename does, so the agent never edits the
 * registry file by hand. It checks the request first, asks the person through upstream's approval service from inside
 * the call (so no `tools/pre-execute` listener can let it through unasked, and only `allowed-once` runs it), then
 * renames through the `deloWorkspaces` service. The call and its result are ordinary session events.
 * @module @delo/plugin-workspaces/rename-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { RenameRequest, WorkspaceRefusedError } from './service.ts'

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

/**
 * The tool.
 * @param ctx - the plugin context with the workspaces service; the approval service is read when the call asks.
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
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    async execute(args, exec) {
      const request = RenameRequest.safeParse(args)
      if (!request.success) {
        throw new RenameToolError('WORKSPACE_RENAME_INVALID', 'Give the workspace\'s id or current name, and a new name of 1 to 200 characters.')
      }
      const plan = await refusal(() => ctx.deloWorkspaces.planRename(request.data))
      if (plan.from === plan.to) return `The workspace is already named ${JSON.stringify(plan.to)}.`
      const approval = ctx.get('approval')
      const outcome = approval === undefined || exec.agent === undefined
        ? 'unavailable'
        : await approval.request({
          agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
          reason: `${exec.name}: rename the workspace ${JSON.stringify(plan.from)} to ${JSON.stringify(plan.to)}.`,
          displayReason: {
            en: `The agent asks to rename the workspace ${JSON.stringify(plan.from)} to ${JSON.stringify(plan.to)}.`,
            zh: `智能体请求将工作区 ${JSON.stringify(plan.from)} 重命名为 ${JSON.stringify(plan.to)}。`,
          },
        })
      if (outcome !== 'allowed-once') {
        throw new RenameToolError('WORKSPACE_RENAME_DECLINED', `The person did not allow it (${outcome}), so nothing changed. Ask them in a reply instead.`)
      }
      const renamed = await refusal(() => ctx.deloWorkspaces.rename(request.data))
      return `Renamed the workspace ${JSON.stringify(renamed.from)} to ${JSON.stringify(renamed.to)}.`
    },
    presentCall: args => ({ card: 'generic', title: `Rename the workspace ${args.workspace} to ${args.name}`, kind: 'other', rawInput: args }),
  })
}

/**
 * Run a service call and pass a refusal on in its own words.
 * @param run - the call.
 * @returns the call's result.
 * @throws RenameToolError `WORKSPACE_RENAME_REFUSED` when the service refused.
 */
async function refusal<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) {
      throw new RenameToolError('WORKSPACE_RENAME_REFUSED', `Delo refused it (${error.code}): ${error.message}`, { cause: error })
    }
    throw error
  }
}
