/** The person in this scenario: allows the one card that starts Claude Code. */
export const name = 'live-agent-person'

/** Answer every card allowed-once through the normal approval audit path. */
export function apply(ctx) {
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
}
