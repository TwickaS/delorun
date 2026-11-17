/**
 * The `use_my_browser` model tool, which asks the person for their own browser in this chat, and the guard that admits
 * each browse call only in a turn that may use the chat's grant.
 * @module @delorun/browser-use-browse/tool
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { RealBrowserGrants, UseVerdict } from './grant.ts'
import {
  ALREADY_GRANTED_ANSWER, askText, AWAY_REFUSAL, BROWSE_SERVER, BROWSE_TOOL_PREFIX, declinedRefusal, grantedAnswer,
  NO_GRANT_REFUSAL, UNANSWERABLE_REFUSAL, USE_MY_BROWSER_DESCRIPTION, USE_MY_BROWSER_TOOL,
} from './copy.ts'

/** The tool's answer: whether the chat may now use the person's own browser, and the sentence the model reads. */
export interface UseMyBrowserAnswer {
  readonly allowed: boolean
  readonly message: string
}

/** The longest purpose the card shows, in characters. */
const MAX_PURPOSE = 300

/**
 * The tool.
 * @param ctx - the plugin context; the approval service is read when the call asks.
 * @param grants - the chats' grants.
 * @returns the tool definition.
 */
export function useMyBrowserTool(ctx: Context, grants: RealBrowserGrants): ToolDefinition {
  return defineTool({
    name: USE_MY_BROWSER_TOOL,
    description: USE_MY_BROWSER_DESCRIPTION,
    parameters: {
      reason: { type: 'string', required: true, description: 'The task you need their browser for, in one short line the person reads on the approval card.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'boolean', required: true, description: 'Whether this chat may now use the person\'s own browser.' },
          message: { type: 'string', required: true, description: 'What happened, for the model.' },
        },
      },
      render: (_args: unknown, value: UseMyBrowserAnswer) => [{ type: 'text' as const, text: value.message }],
    },
    async execute(args, exec): Promise<UseMyBrowserAnswer> {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${USE_MY_BROWSER_TOOL} needs a chat: the grant belongs to one`)
      const purpose = args.reason.trim()
      if (purpose.length === 0 || purpose.length > MAX_PURPOSE) {
        throw new Error(`${USE_MY_BROWSER_TOOL}: give the task in one line of 1 to ${String(MAX_PURPOSE)} characters`)
      }
      const session = agent.session
      if (grants.live(session)) return { allowed: true, message: ALREADY_GRANTED_ANSWER }
      // A run the person did not start, such as a scheduled one, raises no card: nobody is there to read it.
      if (!grants.attended(session)) return { allowed: false, message: AWAY_REFUSAL }
      const approval = ctx.get('approval')
      if (approval === undefined) return { allowed: false, message: UNANSWERABLE_REFUSAL }
      // The grant names the ask it answers; the approval service appends it before anyone answers.
      let askedSeq: SessionSeq | undefined
      const hear = ctx.on('session/event', (from: Session, event: SessionEvent) => {
        if (from === session && event.type === 'approval/asked' && event.data.callId === exec.callId) askedSeq = event.seq
      })
      let outcome: Awaited<ReturnType<typeof approval.request>>
      try {
        outcome = await approval.request({
          agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
          reason: `${exec.name}: ${purpose}`,
          displayReason: askText(purpose),
          grants: 'real-browser',
        })
      } finally {
        hear()
      }
      if (outcome === 'unavailable') return { allowed: false, message: UNANSWERABLE_REFUSAL }
      if (outcome !== 'allowed-once') return { allowed: false, message: declinedRefusal(outcome) }
      if (askedSeq === undefined) throw new Error(`${USE_MY_BROWSER_TOOL}: the approval of call ${exec.callId} is not in the chat's log, so no grant was recorded`)
      grants.grant(session, { kind: 'approval', askedSeq })
      return { allowed: true, message: grantedAnswer(purpose) }
    },
    presentCall: args => ({ card: 'generic', title: 'Ask to use your own browser', kind: 'other', rawInput: args }),
  })
}

/**
 * The sentence that refuses a browse call.
 * @param verdict - a refusing verdict.
 * @returns the sentence.
 */
function refusalOf(verdict: Extract<UseVerdict, { kind: 'refuse' }>): string {
  switch (verdict.reason) {
    case 'no-grant': return NO_GRANT_REFUSAL
    case 'away': return AWAY_REFUSAL
  }
}

/**
 * Admit each browse call, and each MCP resource call naming browse, only in a turn that may use its chat's grant; refuse
 * every other with one sentence before the browse server sees it. Registered before the server's own mount, so it runs
 * first.
 * @param ctx - the plugin context.
 * @param grants - the chats' grants.
 */
export function guardBrowseCalls(ctx: Context, grants: RealBrowserGrants): void {
  const resourceTools: ReadonlySet<string> = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  ctx.on('tools/execute', async (exec, next) => {
    const named = typeof exec.arguments === 'object' && exec.arguments !== null && (exec.arguments as { server?: unknown }).server === BROWSE_SERVER
    if (!exec.name.startsWith(BROWSE_TOOL_PREFIX) && !(resourceTools.has(exec.name) && named)) return next()
    const agent = exec.agent
    if (agent === undefined) throw new Error(NO_GRANT_REFUSAL)
    const verdict = grants.mayUse(agent.session)
    if (verdict.kind === 'refuse') throw new Error(refusalOf(verdict))
    return next()
  }, { prepend: true })
}
