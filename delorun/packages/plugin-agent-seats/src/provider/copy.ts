/**
 * The fixed words of the hand-off tools: their descriptions and the sentences a refusal gives the model. A sentence
 * names the agent and what the model does next; the program's own words never reach the model through here.
 * @module @delorun/plugin-agent-seats/provider/copy
 */
import type { ExternalAgentName, GateRefusal } from '@delorun/external-agents/contract'
import { agentTitle, limitRefusal } from '@delorun/external-agents/copy'

/** The plan each agent runs on, as the person knows it. */
const PLAN_NAMES: Readonly<Record<ExternalAgentName, string>> = { 'claude-code': 'Claude', 'codex': 'ChatGPT' }

/** The sentence added to the tool result when the chat has Full access (L57, EA27, EA28). */
export const FULL_ACCESS_REASON = 'This chat has Full access, so Delorun started it without asking and allows its own permission questions automatically; each is logged as allowed.'

/**
 * The model-facing description of one hand-off tool.
 * @param provider - the agent the tool hands work to.
 * @returns the description.
 */
export function handOffDescription(provider: ExternalAgentName): string {
  const name = agentTitle(provider)
  return `Hands a task to the person's own ${name}, which runs on their ${PLAN_NAMES[provider]} plan with their sign-in and plan limits, not on a Delorun model. `
    + `It works as a chat of its own: you and the person can both watch what it does and message it. `
    + `The task goes to ${name} exactly as you write it and ${name} does not see this conversation, so include everything it needs. `
    + 'This tool starts it independently and immediately returns its name. If you are still online when it finishes, the runtime delivers its completion notice, '
    + 'which includes the final answer unless it sent you a message just before finishing. '
    + 'Use `send_message` to steer it while it runs or to continue its conversation after it finishes.'
}

/**
 * The refusal of a hand-off made from an agent already at the seat's depth limit.
 * @param provider - the agent.
 * @param depth - the calling agent's delegation depth.
 * @param maxDepth - the deepest level a hand-off may reach.
 * @returns the sentence.
 */
export function depthRefusal(provider: ExternalAgentName, depth: number, maxDepth: number): string {
  return `${agentTitle(provider)} was not started: this agent is at delegation depth ${depth} and a hand-off may reach depth ${maxDepth} at most. Carry out the work directly.`
}

/**
 * The sentence for each way the start gate refuses a seat.
 * @param provider - the agent that was refused.
 * @param refusal - why the gate refused.
 * @param now - the time, in milliseconds since the epoch, that a limit's reset time is counted from.
 * @returns the sentence the model reads.
 */
export function gateRefusalSentence(provider: ExternalAgentName, refusal: GateRefusal, now: number): string {
  const name = agentTitle(provider)
  switch (refusal.category) {
    case 'not-installed':
      return `${name} was not started: ${name} is not added to this Delorun. Tell the person; do not retry.`
    case 'consent':
      return refusal.reason
    case 'limit':
      return limitRefusal({ provider, window: refusal.window, resetsAt: refusal.resetsAt, now })
    case 'capacity': {
      const busy = refusal.busy.map(agentTitle).join(', ')
      return `${name} was not started: ${refusal.busy.length} live agents already run (${busy}), which is the most this Delorun runs at once. Wait for one to finish, or do the task yourself.`
    }
    case 'seat-running':
      return `${name} was not started: this agent already has a running program. Send it a message instead of starting it again.`
    default:
      return assertNever(refusal)
  }
}

/**
 * Closes a switch over a closed union.
 * @param value - the value no case matched.
 * @returns never.
 * @throws always.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled gate refusal ${JSON.stringify(value)}`)
}
