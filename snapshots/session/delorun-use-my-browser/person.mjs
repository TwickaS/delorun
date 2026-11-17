/** The person's answers in this scenario: Allow on the real-browser card, then turning the grant off after one browse call. */
export const name = 'use-my-browser-person'
export const inject = ['realBrowser']

/** Answer the one card through the normal approval audit path and end the grant once browse has answered. */
export function apply(ctx) {
  ctx.on('approval/request', (request, next) => request.toolName === 'use_my_browser' ? Promise.resolve('allowed-once') : next())
  ctx.on('tools/result', (exec) => {
    if (exec.name === 'mcp__browse__execute' && exec.agent !== undefined) ctx.realBrowser.end(exec.agent.session)
  })
}
