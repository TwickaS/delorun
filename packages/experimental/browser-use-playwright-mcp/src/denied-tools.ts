/** The server's tools that are turned off, and the refusal of a call to one. */
import type { DeniedToolsConfig } from './index.ts'

/**
 * The tools of the pinned Playwright MCP server that run model-written code in the server process, outside the page
 * and outside the agent's sandbox. They are always turned off; no configuration turns one back on. In @playwright/mcp
 * 0.0.80 that is one tool; every other offered tool acts on the page or on files the folder guard checks.
 */
export const SERVER_CODE_TOOLS: readonly string[] = ['browser_run_code_unsafe']

/**
 * Every tool that is turned off for a configuration.
 * @param config - the validated configuration.
 * @returns {@link SERVER_CODE_TOOLS} and the configuration's `deniedTools`, each name once.
 */
export function deniedToolsOf(config: DeniedToolsConfig): string[] {
  return [...new Set([...SERVER_CODE_TOOLS, ...config.deniedTools])]
}

/**
 * The refusal of a call to a tool that is turned off.
 * @param tool - the server's own tool name.
 * @returns the model-visible text.
 */
export function deniedToolMessage(tool: string): string {
  return `The browser tool "${tool}" is turned off here because it runs code outside the page. Use the other browser tools.`
}
