/**
 * The main chat's guard over every other tool: each call of a tool that is
 * not read-only asks the person first, in every turn, through the tool
 * registry's `ask` decision. The main chat runs in the directory that holds
 * every workspace, so a file write or a command there reaches any
 * workspace's files, `AGENTS.md` included, and untrusted text reaches a turn
 * through fetched pages and files as well as other chats. That covers file
 * writes and commands, `run_code`, whose program can write files under the
 * session's file policy without calling a tool, web requests, the plugin
 * manager's changes, and any tool a plugin adds. The account tools ask from
 * inside their own execution instead. Messaging or stopping another chat
 * asks only in a turn that read another chat's or workspace's text. Every
 * question but that one carries the `workspace-management` grant marker, so a
 * Host may keep its granting answer for the home's own computer.
 *
 * @module @delorun/plugin-main-chat/guard
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { readThisTurn } from './account-tools.ts'
import { MAIN_CHAT_SESSION_ID } from './wire.ts'

/**
 * The tools the main chat calls without the guard's question: the ones that only read, ask the person themselves, or
 * change only the main chat's own session state (its working directory, todo list, deliverables and plan mode). None
 * can change a file or state outside the session without a tool call the guard decides.
 */
export const GUARD_FREE: ReadonlySet<string> = new Set([
  'chat_list', 'chat_search', 'chat_read', 'workspace_list', 'workspace_instructions', 'rename_workspace',
  'workspace_create', 'workspace_import', 'workspace_trash', 'workspace_restore', 'workspace_instructions_write', 'workspace_note', 'workspace_note_remove',
  'read', 'read_image', 'glob', 'grep', 'working_directory', 'todo_write', 'skill', 'present', 'ask_user_question', 'exit_plan_mode',
  'job_list', 'job_output', 'get_goal', 'schedule_list', 'list_agents', 'cordis_inspect_list', 'cordis_inspect_query',
])

/**
 * The main chat's tools that message or stop another chat, which ask only in a turn that read another chat's or
 * workspace's text ({@link readThisTurn}): the chat they reach runs under its own workspace's permissions.
 */
export const GUARD_AFTER_READ: ReadonlySet<string> = new Set(['chat_send', 'chat_stop', 'workspace_delegate'])

// The plugin manager's actions that change nothing, which it runs without its own approval too.
const PLUGIN_MANAGER_READS: ReadonlySet<string> = new Set(['list_plugins', 'list_bundles', 'list_version_exemptions', 'history', 'read_config'])

const MAIN = SessionId(MAIN_CHAT_SESSION_ID)

/**
 * Whether a call of the main chat runs without the guard's question.
 * @param exec - the pending call.
 * @returns whether it only reads, asks for itself, or changes only the session's own state.
 */
export function guardFree(exec: Pick<ToolExecution, 'name' | 'arguments'>): boolean {
  if (GUARD_FREE.has(exec.name)) return true
  const action = (exec.arguments as { action?: unknown } | undefined)?.action
  return exec.name === 'plugin_manager' && typeof action === 'string' && PLUGIN_MANAGER_READS.has(action)
}

/**
 * Ask before every other tool call of the main chat that is not {@link guardFree}, and before a
 * {@link GUARD_AFTER_READ} call in a turn that read another chat's or workspace's text. The listener is prepended, so
 * it decides before the tool runs.
 * @param ctx - the plugin context with the tool registry.
 */
export function guardOtherTools(ctx: Context): void {
  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent?.session.id !== MAIN || guardFree(exec)) return next()
    const read = readThisTurn(agent.session)
    const afterRead = GUARD_AFTER_READ.has(exec.name)
    if (afterRead && !read) return next()
    return Promise.resolve({
      kind: 'ask',
      // A command or write here reaches every workspace's files; a message or stop runs under the other chat's own workspace.
      ...afterRead ? {} : { grants: 'workspace-management' as const },
      reason: `${exec.name}: the main chat asks to run it; it runs in the directory that holds every workspace.${read ? ' This turn read another chat or workspace, whose text can carry instructions.' : ''}`,
      displayReason: {
        en: `The main chat asks to run ${exec.name}, in the directory that holds every workspace.${read ? ' This turn read another chat or workspace, whose text can carry instructions.' : ''}`,
        zh: `主对话请求在包含所有工作区的目录中运行 ${exec.name}。${read ? '本轮读取了另一个对话或工作区，其内容可能带有指令。' : ''}`,
      },
    })
  }, { prepend: true })
}
