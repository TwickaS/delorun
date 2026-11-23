/**
 * Whether the studio's page is at the person's computer, for the client gates that show or hide controls.
 *
 * The Delorun desktop app serves its own bundled studio under `dsh-app://app`, so the page's host name says nothing about
 * where the person is. Its preload instead exposes `globalThis.delorunDesktop`, a frozen object with one key, `homeKind`:
 * `bundled` (the home the app runs) and `wsl` (a home in the person's WSL distribution) are the person's own computer, and
 * `remote` is a home on another machine, which the app treats as a device (A579).
 *
 * This answers a question of presentation only. A client gate hides or shows a control; the home's own server-side checks
 * stay the authority and refuse what a page has no right to ask, whatever a page claims. Nothing here grants anything.
 */

/** The scheme and host of the desktop's application document: the only page its preload gives `delorunDesktop` (`apps/desktop/src/ipc.ts` `SCHEME`). */
const DESKTOP_APP_SCHEME = 'dsh-app'
const DESKTOP_APP_HOST = 'app'

/** Where the desktop app's home runs, as its preload reports it. */
export type DesktopHomeKind = 'bundled' | 'wsl' | 'remote'

/**
 * Read the home kind the desktop preload exposes.
 *
 * The preload exposes the object on the application document only (`dsh-app://app`), so the global is read only there: a
 * web page, whatever script runs in it, cannot change the answer by defining `delorunDesktop` itself.
 * @returns the kind, or `undefined` when the page is not the desktop's application document, when the object or its value
 *   is anything other than the preload's own shape (a DOM element that an `id` or `name` made the global is not), or when
 *   reading it throws.
 */
export function desktopHomeKind(): DesktopHomeKind | undefined {
  try {
    const page: unknown = Reflect.get(globalThis, 'location')
    if (typeof page !== 'object' || page === null) return undefined
    if (Reflect.get(page, 'protocol') !== `${DESKTOP_APP_SCHEME}:` || Reflect.get(page, 'hostname') !== DESKTOP_APP_HOST) return undefined
    const desktop: unknown = Reflect.get(globalThis, 'delorunDesktop')
    if (typeof desktop !== 'object' || desktop === null) return undefined
    const kind: unknown = Reflect.get(desktop, 'homeKind')
    return kind === 'bundled' || kind === 'wsl' || kind === 'remote' ? kind : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the page is at the person's computer.
 * @param fallback - the caller's own answer outside the desktop app, such as a loopback host name test or the connection's
 *   `isLoopback`; it is returned unchanged when the desktop reports no usable home kind.
 * @returns `true` for a `bundled` or `wsl` home, `false` for a `remote` one, otherwise `fallback`.
 */
export function atComputer(fallback: boolean): boolean {
  const kind = desktopHomeKind()
  if (kind === undefined) return fallback
  return kind !== 'remote'
}
