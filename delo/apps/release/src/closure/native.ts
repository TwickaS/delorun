/**
 * Native code in a staged closure. Every ELF, Mach-O and PE file outside the pinned Node distribution must be a
 * prebuilt file whose SHA-256 `prebuilt-pins.json` lists for that platform, so a build that compiled an addon instead
 * of taking its pinned prebuilt, or that took a different prebuilt, stops before archiving (contract C2, rebuild
 * before signing).
 *
 * @module @delo/release/closure/native
 */
import { isPeFile } from '../rebuild/pe.ts'

/** The staged directory of the pinned Node distribution, which `toolchain.json` pins by archive digest. */
export const NODE_DIRECTORY = 'node'

/**
 * Whether bytes are native machine code: an ELF file, a thin or universal Mach-O file, or a PE image.
 * @param data - the file's bytes, or at least its first 4 KiB.
 * @returns true for native code.
 */
export function isNativeCode(data: Buffer): boolean {
  if (data.byteLength < 8) return false
  const magic = data.readUInt32BE(0)
  if (magic === 0x7f454c46) return true
  if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) return true
  // A universal Mach-O header shares 0xcafebabe with Java class files; its architecture count is small, while a
  // class file has its version number (45 or more) there.
  if ((magic === 0xcafebabe || magic === 0xcafebabf) && data.readUInt32BE(4) > 0 && data.readUInt32BE(4) < 32) return true
  return isPeFile(data)
}

/**
 * Compare the native files found in a closure with its pins.
 * @param found - path to SHA-256 of every native file outside {@link NODE_DIRECTORY}.
 * @param pinned - the platform's pins.
 * @returns one message per unpinned file, changed digest and pinned file that is missing; empty when they agree.
 */
export function nativePinProblems(found: ReadonlyMap<string, string>, pinned: Readonly<Record<string, string>>): string[] {
  const problems: string[] = []
  for (const [path, sha256] of found) {
    const expected = pinned[path]
    if (expected === undefined) problems.push(`${path}: native code that prebuilt-pins.json does not list`)
    else if (expected !== sha256) problems.push(`${path}: SHA-256 ${sha256}, but prebuilt-pins.json pins ${expected}`)
  }
  for (const path of Object.keys(pinned)) {
    if (!found.has(path)) problems.push(`${path}: pinned in prebuilt-pins.json but absent from the closure`)
  }
  return problems.sort()
}
