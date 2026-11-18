/** The `--browser` value a launch passes to the server. */
import { launchedBrowser, type LaunchedBrowser } from '@deepseek-ai/dsh-native-command/chrome-channel'
import type { LaunchConfig } from './index.ts'

/**
 * The `--browser` value of a launch. The answer reads only the configuration and whether Chrome is installed, so the
 * server's arguments, which the MCP add-time consent covers, stay the same on one computer until Chrome is installed
 * or removed.
 * @param config - the launch settings.
 * @returns {@link launchedBrowser}'s answer for the configured browser and `executablePath`.
 */
export function launchBrowser(config: LaunchConfig): LaunchedBrowser {
  return launchedBrowser(config.browser, undefined, config.executablePath)
}
