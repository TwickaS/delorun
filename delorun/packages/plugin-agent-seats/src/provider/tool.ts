/**
 * The hand-off tool of one seat: the lead's model hands a task to the person's own Claude Code or Codex. It assembles
 * the request as upstream's `tool-subagent` does for a continuable provider, with the route and preset fixed by the
 * seat's configuration, and starts the seat child through `ctx.subagents`.
 * @module @delorun/plugin-agent-seats/provider/tool
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertSubagentMaxDepth, delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { GateRefusedError, type ExternalAgentName } from '@delorun/external-agents/contract'
import { agentTitle } from '@delorun/external-agents/copy'
import type { SeatConfig } from '../config.ts'
import { depthRefusal, FULL_ACCESS_REASON, gateRefusalSentence, handOffDescription } from './copy.ts'
import { SEAT_MODEL, seatProviderName } from './provider.ts'

/** What the tool needs beyond its context. */
export interface HandOffOptions {
  /** The clock a limit's reset time is counted from, in milliseconds since the epoch. */
  readonly now: () => number
}

/**
 * Whether the delegating chat's tree runs without asking: the root's approval policy is `never`, which is what the
 * Full access preset sets. The consent reads the same value.
 * @param ctx - the plugin context.
 * @param parent - the delegating agent.
 * @returns true when nobody is asked.
 */
function runsWithoutAsking(ctx: Context, parent: Parameters<Context['subagents']['rootOf']>[0]): boolean {
  const approval = ctx.get('approval')
  if (approval === undefined) return false
  const root = ctx.subagents.rootOf(parent)
  return (approval.overrideOf(root.session) ?? approval.config.policy) === 'never'
}

/**
 * Build the hand-off tool of one seat.
 * @param ctx - the plugin context with `subagents`, `externalAgents` and `llm`.
 * @param seat - the configured seat; its `provider` is an {@link ExternalAgentName}.
 * @param provider - the seat's agent, already validated.
 * @param options - the clock.
 * @returns the tool definition, named by `seat.toolName`.
 */
export function handOffTool(ctx: Context, seat: SeatConfig, provider: ExternalAgentName, options: HandOffOptions): ToolDefinition {
  assertSubagentMaxDepth(seat.maxDepth)
  const title = agentTitle(provider)
  return defineTool({
    name: seat.toolName,
    description: handOffDescription(provider),
    parameters: {
      cwd: {
        type: 'string',
        description: 'Initial working directory for the agent. Relative paths use your current directory; omitted inherits it.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the task, for display. Use the language of the user\'s current request.',
      },
      name: {
        type: 'string',
        description: 'Optional short name for the agent, unique among the subagents you create: lower-case letters, '
          + 'digits, and hyphens, starting with a letter, at most 32 characters; lead is reserved for the root agent. Omitted names default to agent-1, agent-2, and so on.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: `The complete, self-contained task for ${title}. It does not see this conversation, so include everything it needs.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          name: { type: 'string', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started ${title} as ${value.name}${value.reason === undefined ? '' : `. ${value.reason}`}` }],
      presentationMeta: (_args, value) => ({ kind: value.kind, name: value.name, ...value.reason === undefined ? {} : { reason: value.reason } }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${seat.toolName} requires a calling agent (exec.agent was undefined)`)
      const { maxDepth } = seat
      const depth = delegationDepthOf(parent)
      if (depth >= maxDepth) throw new Error(depthRefusal(provider, depth, maxDepth))
      const limit = await ctx.externalAgents.limitRefusal(provider)
      if (limit !== undefined) throw new Error(limit)
      const llm = ctx.get('llm')
      if (llm === undefined) throw new Error(`${seat.toolName} cannot resolve the ${title} route because the llm service is unavailable`)
      const agentOptions = { provider: seat.route, model: SEAT_MODEL }
      await llm.resolveCallConfig(agentOptions, exec.signal)
      exec.signal.throwIfAborted()
      const reason = runsWithoutAsking(ctx, parent) ? FULL_ACCESS_REASON : undefined
      let started
      try {
        started = await ctx.subagents.startActivation({
          provider: seatProviderName(seat.provider),
          label: args.description,
          ...args.name === undefined ? {} : { name: args.name },
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
          parent,
          agentPreset: seat.preset,
          agentOptions,
          maxDepth,
          signal: exec.signal,
          delivery: 'parent',
        })
      } catch (error) {
        if (error instanceof GateRefusedError) throw new Error(gateRefusalSentence(provider, error.refusal, options.now()), { cause: error })
        throw error
      }
      return {
        kind: 'activation' as const,
        name: started.name,
        ...reason === undefined ? {} : { reason },
      }
    },
  })
}
