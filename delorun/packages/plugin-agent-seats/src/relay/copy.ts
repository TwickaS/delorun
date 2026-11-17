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

/** Why Delorun refused a program's question without asking the person. */
export type QuestionRefusal = 'no-relay' | 'not-a-seat' | 'no-approval'

const REFUSAL_REASONS: Readonly<Record<QuestionRefusal, string>> = {
  'no-relay': 'this chat has no way to ask you',
  'not-a-seat': 'this chat is not a live agent\'s chat',
  'no-approval': 'the approval service is not running',
}

/**
 * The notice for a question Delorun refused without asking.
 * @param tool - the program's own tool name.
 * @param why - the reason.
 * @returns the sentence the chat shows.
 */
export function questionRefusedNotice(tool: string, why: QuestionRefusal): string {
  return `The live agent asked to use ${tool}. Delorun refused it without asking you, because ${REFUSAL_REASONS[why]}.`
}
