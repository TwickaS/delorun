/** The replacement for Playwright's report of a browser that is not installed. */

/**
 * The tool failure that replaces Playwright's report that Google Chrome, which the configuration tells it to launch,
 * is not installed. The model cannot install it, so the text tells it to stop and send the person to Browser's setup.
 */
export const MISSING_CHROME_MESSAGE = 'Browser is set to use Google Chrome, which is not installed on this computer, so no browser tool can run until the person finishes Browser setup in Plugins. Stop using browser tools and other ways to browse for this request; tell the person to finish Browser setup in Plugins, then ask again.'

/**
 * The tool failure that replaces Playwright's report of a browser build that is not installed. The model cannot install
 * it, so the text tells it to stop and send the person to Browser's setup.
 */
export const MISSING_BROWSER_MESSAGE = 'Browser needs its Chromium download, so no browser tool can run until the person finishes Browser setup in Plugins. Stop using browser tools and other ways to browse for this request; tell the person to finish Browser setup in Plugins, then ask again.'

/**
 * How a failure from Playwright's MCP server starts: its `### Error` header line, then an optional `Error: `. A failure
 * without the header starts the same way.
 */
const FAILURE_START = '^(?:### Error\\n)?(?:Error: )?'

/**
 * Playwright's report that the `chrome` channel has no installed Chrome, at the start of a failure:
 * `[browserType.launch: ]Chromium distribution 'chrome' is not found`.
 */
const MISSING_CHROME_PATTERN = new RegExp(`${FAILURE_START}(?:browserType\\.\\w+: )?Chromium distribution 'chrome' is not found`, 'u')

/**
 * Playwright's reports of a browser executable that is not installed, at the start of a failure: its launch error,
 * `[browserType.launch: ]Executable doesn't exist at <path>`, and the MCP server's rewording of it, `Browser "<name>" is
 * not installed[; expected executable at <path>]. Run \`npx @playwright/mcp install-browser <name>\` to install`. The
 * same words later in a failure, such as in a page's own text, are not such a report.
 */
const MISSING_BROWSER_PATTERN = new RegExp(`${FAILURE_START}(?:${[
  '(?:browserType\\.\\w+: )?Executable doesn\'t exist at \\S',
  'Browser "[\\w-]+" is not installed(?:; expected executable at [^\\r\\n]+)?\\. Run `npx @playwright/mcp install-browser [\\w-]+` to install',
].join('|')})`, 'u')

/**
 * Replace Playwright's report of a browser that is not installed.
 * @param message - a failed browser tool call's error message.
 * @returns {@link MISSING_BROWSER_MESSAGE} for a missing browser build, {@link MISSING_CHROME_MESSAGE} for a missing
 * Chrome, otherwise `undefined`.
 */
export function explainMissingBrowser(message: string): string | undefined {
  if (MISSING_BROWSER_PATTERN.test(message)) return MISSING_BROWSER_MESSAGE
  return MISSING_CHROME_PATTERN.test(message) ? MISSING_CHROME_MESSAGE : undefined
}
