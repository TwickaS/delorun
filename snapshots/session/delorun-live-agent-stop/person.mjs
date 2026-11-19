/** The person in this scenario: allows the card that starts Claude Code, then stops the agent while its Bash command is open. */
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
    agent.cancel({ kind: 'user' })
  }), 'live-agent-person: act on the first recorded call')
}
