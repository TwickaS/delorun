/**
 * Which repository addresses and folder names the clone route takes. Browser-safe, so the studio checks an address as
 * the person types it with the same rule the harness enforces.
 * @module @delo/plugin-onboarding/clone-address
 */

/** A host name, which may not begin with `-`. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/u

/** An `scp`-style SSH address: `user@host:path`, where the path is not empty, not `//`-led and not `-`-led. */
const SCP_FORM = /^([A-Za-z0-9._-]{1,64})@([^:/\s]{1,253}):(?!\/\/)([^\s-][^\s]{0,2000})$/u

/**
 * Whether an address is one this route clones from.
 * @param url - the address as the person typed it.
 * @returns true for an `https://` or `ssh://` URL with a host, or a `user@host:path` address; never for a local path,
 * `file://`, `ext::`, another scheme or a value led by `-` or holding whitespace or a control character.
 */
export function isCloneAddress(url: string): boolean {
  if (url.startsWith('-') || /[\s\u0000-\u001f\u007f]/u.test(url) || url.includes('::')) return false
  const scp = SCP_FORM.exec(url)
  if (scp !== null) return HOST.test(scp[2] as string)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (_notUrl) {
    // Neither form: a local path or a bare word.
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return false
  return HOST.test(parsed.hostname) || /^\[[0-9a-fA-F:.]+\]$/u.test(parsed.hostname)
}

/**
 * Whether a name is one the clone route creates a folder under.
 * @param name - the new folder's name as typed.
 * @returns whether it is one plain folder name: no separator, not `.` or `..`, not `-`-led, no control character.
 */
export function isFolderName(name: string): boolean {
  return name !== '.' && name !== '..' && !name.startsWith('-') && !/[/\\\u0000-\u001f\u007f]/u.test(name) && name.trim() === name
}

/**
 * The folder name a clone suggests: the address's last path part without `.git`.
 * @param url - a repository address.
 * @returns the name, or empty when the address has none that {@link isFolderName} takes.
 */
export function suggestedName(url: string): string {
  const name = url.replace(/[/\\]+$/u, '').replace(/^.*[/:]/u, '').replace(/\.git$/u, '')
  return name !== '' && isFolderName(name) ? name : ''
}
