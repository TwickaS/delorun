/**
 * The words of a seat's approval card.
 * @module @delorun/plugin-agent-seats/relay/copy
 */

/**
 * The reason a card shows for a program's question: the program's own words, said by the agent.
 * @param agent - the agent's product name, such as `Claude Code`.
 * @param reason - the program's plain description of what it wants to do.
 * @returns the reason in English and Chinese, keyed by locale.
 */
export function programSays(agent: string, reason: string): { readonly en: string, readonly zh: string } {
  return { en: `${agent} says: ${reason}`, zh: `${agent}说：${reason}` }
}
