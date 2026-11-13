/**
 * The terminal switch store: `~/.delo/secrets/home-auth/reach-terminal.json`, mode 0600, holding whether a device the
 * home approved opens a terminal without an unlock everywhere (C14, "Elevation"). It is off until the person turns it
 * on at the home's own computer; any studio of the home's, a device's included, may turn it off.
 *
 * The policy decides each terminal call synchronously, so the store is read synchronously. Every profile of the home
 * shares the directory, so a read compares the file's identity with the one it last read and reads the file again when
 * it differs. A missing file, and a file that is refused or does not hold this package's JSON, reads as off: the
 * switch only ever lowers protection, so a store that cannot be trusted keeps the unlock.
 *
 * @module @delo/home-auth/reach-terminal
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { checkProtectedFileSync } from '@delo/home'
import { writeStoreFile } from './files.ts'

/** Format version of the terminal switch store. */
export const REACH_TERMINAL_VERSION = 1 as const

/** What the terminal switch store holds. */
export interface ReachTerminalRecord {
  readonly v: typeof REACH_TERMINAL_VERSION
  /** Whether a device opens a terminal without an unlock in every folder. */
  readonly withoutUnlock: boolean
}

/** The open flags of the read: never follow a symbolic link where the platform can refuse one. */
/* v8 ignore next -- the platform decides which side runs; the suite runs on Linux and macOS. */
const READ_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)

/**
 * The identity of the store file: device, inode, size and modification time, or `absent`.
 * @param path - the file's absolute path.
 * @returns the identity's text.
 */
function identityOf(path: string): string {
  try {
    const stats = lstatSync(path)
    return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`
  } catch (error) {
    return `unexaminable:${String((error as NodeJS.ErrnoException).code)}`
  }
}

/**
 * Read the switch from the file, off for anything but a readable record that says on.
 * @param path - the file's absolute path.
 * @returns whether the switch is on.
 */
function readSwitch(path: string): boolean {
  let text: string
  try {
    const checked = checkProtectedFileSync(path)
    const fd = openSync(path, READ_FLAGS)
    try {
      const opened = fstatSync(fd)
      /* v8 ignore next -- a file renamed over the path between the check and the open; no test can order that. */
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) return false
      text = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
  } catch (_unreadable: unknown) {
    // Missing, refused by the protected-file rule or unreadable: the unlock stays.
    return false
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson: unknown) {
    // A file that is not JSON keeps the unlock as well.
    return false
  }
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'v') === REACH_TERMINAL_VERSION && Reflect.get(value, 'withoutUnlock') === true
}

/** The terminal switch of one home, read through the file's identity. */
export class ReachTerminalStore {
  private readonly file: string
  private identity: string | undefined
  private on = false

  /**
   * @param file - the absolute path of `reach-terminal.json`.
   */
  constructor(file: string) {
    this.file = file
  }

  /**
   * Whether a device opens a terminal without an unlock everywhere, as the file holds it now.
   * @returns whether the switch is on.
   */
  withoutUnlock(): boolean {
    const identity = identityOf(this.file)
    if (identity !== this.identity) {
      this.identity = identity
      this.on = readSwitch(this.file)
    }
    return this.on
  }

  /**
   * Write the switch.
   * @param withoutUnlock - whether a device opens a terminal without an unlock everywhere.
   */
  async set(withoutUnlock: boolean): Promise<void> {
    const record: ReachTerminalRecord = { v: REACH_TERMINAL_VERSION, withoutUnlock }
    await writeStoreFile(this.file, record)
  }
}
