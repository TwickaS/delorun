/** The person in this scenario: allows the card that starts Claude Code, then sends the agent a message while its Bash command is open. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'live-agent-person'
export const inject = ['seatPrograms', 'agents']

/** Answer every card allowed-once; act once, when the program's first call has its record in the seat's log. */
export function apply(ctx) {
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  let acted = false
  ctx.effect(() => ctx.seatPrograms.records.onCallRecorded(({ sessionId }) => {
    if (acted) return
    acted = true
    const agent = ctx.agents.get(sessionId)
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'Also run the lint step afterwards.' }], source: { kind: 'user' } }))
  }), 'live-agent-person: act on the first recorded call')
}
