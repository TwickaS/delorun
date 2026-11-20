/**
 * The Face ID pass setting (A499): how many minutes one Face ID on a device opens a pass for, chosen from
 * {@link PASS_MINUTES}. `0` is "Every time": no pass opens, and every strong action asks as it did before passes existed.
 * The person's choice is kept in `face-id-pass.json` in the secrets directory; until they choose, the deployment default
 * (the service's validated `faceIdPassMinutes` config field) applies.
 *
 * @module @delorun/home-auth/pass-setting
 */
import { readStoreFile, writeStoreFile, isRecord } from './files.ts'
import { HomeAuthError } from './errors.ts'

/** The choices of "Ask again after": Every time, then 5, 15, 30 and 60 minutes. */
export const PASS_MINUTES = [0, 5, 15, 30, 60] as const

/** One of {@link PASS_MINUTES}. */
export type PassMinutes = (typeof PASS_MINUTES)[number]

/** The deployment default when the config names none: 15 minutes. */
export const PASS_MINUTES_DEFAULT: PassMinutes = 15

/** The version of `face-id-pass.json`. */
const PASS_SETTING_VERSION = 1

/**
 * Whether a value is one of the choices.
 * @param value - a value read from a message, a file or the config.
 * @returns whether it is one of {@link PASS_MINUTES}.
 */
export function isPassMinutes(value: unknown): value is PassMinutes {
  return PASS_MINUTES.some(choice => choice === value)
}

/** The person's choice of the pass length, on disk. */
export class PassSettingStore {
  private readonly file: string
  private chosen: PassMinutes | undefined
  /**
   * @param options - where the choice lives.
   * @param options.file - the absolute path of `face-id-pass.json`.
   */
  constructor(options: { readonly file: string }) {
    this.file = options.file
  }

  /**
   * Read the choice; a missing file is no choice.
   * @throws {HomeAuthError} `STORE_INVALID` for a file that is not this package's record or names a length outside {@link PASS_MINUTES}.
   */
  async load(): Promise<void> {
    const value = await readStoreFile(this.file)
    if (value === undefined) {
      this.chosen = undefined
      return
    }
    if (!isRecord(value) || value.v !== PASS_SETTING_VERSION || !isPassMinutes(value.minutes)) {
      throw new HomeAuthError('STORE_INVALID', 'face-id-pass.json is not a Face ID pass setting this home can read')
    }
    this.chosen = value.minutes
  }

  /** @returns the person's choice, or undefined while they have not chosen. */
  get(): PassMinutes | undefined {
    return this.chosen
  }

  /**
   * Record a choice.
   * @param minutes - the new length.
   */
  async set(minutes: PassMinutes): Promise<void> {
    await writeStoreFile(this.file, { v: PASS_SETTING_VERSION, minutes })
    this.chosen = minutes
  }
}
