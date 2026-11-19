/**
 * Hides upstream's one-shot tools (`subagent_claude_code`, `subagent_codex`) from an agent that has the seat's
 * hand-off tool, so a chat's model sees one tool per program. The one-shot tools stay for workflows and headless
 * profiles, which name the provider and never see a seat tool.
 * @module @delorun/plugin-agent-seats/provider/hide
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One seat's hand-off tool and the upstream tool it replaces. */
export interface HiddenOneShot {
  /** The seat's hand-off tool name. */
  readonly seatTool: string
  /** The upstream one-shot tool name. */
  readonly oneShotTool: string
}

/**
 * The name upstream gives the one-shot tool of an agent.
 * @param provider - the agent's provider name, such as `claude-code`.
 * @returns the tool name, such as `subagent_claude_code`.
 */
export function oneShotToolName(provider: string): string {
  return `subagent_${provider.replaceAll('-', '_')}`
}

/**
 * Deny the one-shot tools an agent no longer needs. A one-shot tool that is not registered is not named, because a
 * restriction naming an unknown tool throws.
 * @param ctx - the plugin context.
 * @param agent - the agent that was just created.
 * @param hidden - every seat's tools.
 */
export function hideOneShotTools(ctx: Context, agent: Agent, hidden: readonly HiddenOneShot[]): void {
  const deny = hidden
    .filter(entry => ctx.tools.get(entry.seatTool, agent) !== undefined && ctx.tools.get(entry.oneShotTool, agent) !== undefined)
    .map(entry => entry.oneShotTool)
  if (deny.length > 0) agent.ctx.tools.restrict({ deny })
}
