/**
 * The sentences the model and the approval card read for the person's own browser.
 * @module @delorun/browser-use-browse/copy
 */

/** The MCP server name of browse, which prefixes its tools: `mcp__browse__execute`, `…status`, `…tabs`. */
export const BROWSE_SERVER = 'browse'

/** The prefix of every browse tool name. */
export const BROWSE_TOOL_PREFIX = `mcp__${BROWSE_SERVER}__`

/** The model tool that asks for the person's own browser. */
export const USE_MY_BROWSER_TOOL = 'use_my_browser'

/** The tool's description. */
export const USE_MY_BROWSER_DESCRIPTION = 'Ask the person to let you use their own browser, with their sign-ins, in this chat. '
  + 'Use it only when a task needs a site where they are signed in, and keep the isolated browser for everything else. '
  + 'They answer on an approval card; once they allow it, the browse tools (mcp__browse__execute, status and tabs) appear from your next step and stay for this chat until they turn it off.'

/** The refusal of a browse call in a chat without a running grant. */
export const NO_GRANT_REFUSAL = 'The person\'s own browser is not allowed in this chat, so this call did not run. Use the isolated browser, or call use_my_browser to ask.'

/** The refusal of a browse call, and of `use_my_browser`, in a run the person did not start and without the away permission. */
export const AWAY_REFUSAL = 'This run started without the person, and they have not allowed their own browser for runs while they are away, so it stays off here. Use the isolated browser instead.'

/** The refusal of `use_my_browser` where nobody can answer, such as a headless run. */
export const UNANSWERABLE_REFUSAL = 'Nobody can answer here to allow the person\'s own browser, so it stays off in this run. Use the isolated browser instead.'

/**
 * The refusal of `use_my_browser` after the person's answer.
 * @param outcome - the approval outcome other than `allowed-once`.
 * @returns the sentence.
 */
export function declinedRefusal(outcome: string): string {
  return `The person did not allow their own browser (${outcome}), so nothing changed. Carry on with the isolated browser, and do not ask again for this task.`
}

/**
 * The tool's answer once the person allowed it, which announces the grant to the model.
 * @param purpose - the task the model asked for it.
 * @returns the sentence.
 */
export function grantedAnswer(purpose: string): string {
  return `The person allowed their own browser, with their sign-ins, for this chat. Use it only for: ${purpose}. `
    + 'Keep the isolated browser for everything else. Its tools, mcp__browse__execute, mcp__browse__status and mcp__browse__tabs, are available from your next step.'
}

/** The tool's answer when the chat already holds a grant. */
export const ALREADY_GRANTED_ANSWER = 'The person\'s own browser is already allowed in this chat; use the mcp__browse__ tools.'

/**
 * The tool's answer when the chat holds a grant but browse offers it no tools, such as while the person has not yet
 * accepted starting browse on this computer.
 * @param purpose - the task the grant is for.
 * @returns the answer.
 */
export function browseWaitingAnswer(purpose: string): string {
  return `The person allowed their own browser, with their sign-ins, for this chat, for: ${purpose}. `
    + 'Its tools are not available yet: browse has not started, because the person has not accepted starting it on this computer or it could not start. '
    + 'Tell the person, and keep the isolated browser until the mcp__browse__ tools appear.'
}

/**
 * The approval card's text: what the agent asks for and what it can do with it.
 * @param purpose - the task the model gave.
 * @returns the English and Chinese text.
 */
export function askText(purpose: string): { readonly en: string; readonly zh: string } {
  return {
    en: `The agent asks to use your own browser, with your sign-ins, in this chat, for: ${purpose}. It opens its own tabs and can read any page it opens.`,
    zh: `智能体请求在此对话中使用你自己的浏览器（包括你的登录状态），用于：${purpose}。它会打开自己的标签页，并能读取它打开的任何页面。`,
  }
}
