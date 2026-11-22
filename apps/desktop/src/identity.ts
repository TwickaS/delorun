/** Product identity of the Delorun desktop app: its name, link scheme, data folder and preview label. */

import { join } from 'node:path'

/** The product name shown in window titles, menus and the installer. */
export const DESKTOP_PRODUCT_NAME = 'Delorun'

/** The scheme the app registers; `delorun://open` raises the window. */
export const DESKTOP_LINK_SCHEME = 'delorun'

/**
 * The folder that holds the app's own data (settings, logs, crash reports), beside other applications' data.
 * @param appData - The operating system's per-user application data folder (`%APPDATA%` on Windows).
 * @returns `<appData>/Delorun`, so a DeepSeek Harness desktop app installed on the same PC never shares it.
 */
export function desktopUserDataPath(appData: string): string {
  return join(appData, DESKTOP_PRODUCT_NAME)
}

/**
 * Whether a link asks the app to raise its window.
 * @param url - The link the operating system passed to the app.
 * @returns true only for `delorun://open` and `delorun://open/`.
 */
export function isDesktopOpenLink(url: string): boolean {
  return url === `${DESKTOP_LINK_SCHEME}://open` || url === `${DESKTOP_LINK_SCHEME}://open/`
}
