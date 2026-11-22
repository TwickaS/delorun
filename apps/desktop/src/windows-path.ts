/**
 * Windows paths for a home in WSL2. The studio sends a dropped file's path to a home that runs inside a Linux
 * distribution, so the path has to be one the distribution can open: a drive path becomes its `/mnt/<drive>` path and a
 * path on this distribution's own file system (`\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…`) becomes the Linux path.
 * Anything else is refused.
 */

/** A translated path, or a refusal. */
export type HostPathResult = { readonly ok: true; readonly path: string } | { readonly ok: false }

const DRIVE_PATH = /^([A-Za-z]):\\(.*)$/u
const WSL_SHARE = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/iu
const CONTROL_CHARACTER = /[\u0000-\u001f]/u

/** Split path text on either separator; `undefined` when a segment is `.` or `..` or holds a control character. */
function segmentsOf(text: string): string[] | undefined {
  const segments = text.split(/[\\/]/u).filter(segment => segment !== '')
  return segments.some(segment => segment === '.' || segment === '..' || CONTROL_CHARACTER.test(segment)) ? undefined : segments
}

/**
 * Translate a Windows path into the path the distribution sees.
 * @param nativePath - The path Electron reports for a dropped or picked file.
 * @param distro - The WSL distribution that runs the home.
 * @returns the Linux path, or `{ ok: false }` for a relative path, a path on another distribution or a network share,
 *   a device path (`\\?\`), a drive path with a stream (`:`) or a `.`/`..` segment, and anything else.
 */
export function translateWindowsPath(nativePath: string, distro: string): HostPathResult {
  const drive = DRIVE_PATH.exec(nativePath)
  if (drive !== null) {
    const segments = segmentsOf(drive[2] ?? '')
    if (segments === undefined || segments.some(segment => segment.includes(':'))) return { ok: false }
    return { ok: true, path: `/mnt/${(drive[1] as string).toLowerCase()}${segments.map(segment => `/${segment}`).join('')}` }
  }
  const share = WSL_SHARE.exec(nativePath)
  if (share !== null && (share[1] as string).toLowerCase() === distro.toLowerCase()) {
    const segments = segmentsOf(share[2] ?? '')
    if (segments === undefined) return { ok: false }
    return { ok: true, path: segments.length === 0 ? '/' : segments.map(segment => `/${segment}`).join('') }
  }
  return { ok: false }
}

/**
 * The plain message shown when a path is refused. English only for now; the Chinese pair is logged for the translation lane.
 * @param distro - The WSL distribution that runs the home.
 * @returns the message text.
 */
export function hostPathRefusal(distro: string): string {
  return `This file is in a place that "${distro}" cannot open. Put it in a folder on a Windows drive, such as C:\\, or inside "${distro}", then drop it again.`
}
