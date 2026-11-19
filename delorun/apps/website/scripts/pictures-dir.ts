/**
 * Where the home page's source pictures live. The screenshots are not in the repository: `SITE_PICTURES_DIR` names a
 * folder of `<picture id>.webp` files (written by `wall-shots.ts` and `ingest-owner-shots.ts`), and the build that makes
 * the picture pyramid reads them from there.
 *
 * @module @delorun/website/scripts/pictures-dir
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** The environment variable that names the folder. */
export const PICTURES_VARIABLE = 'SITE_PICTURES_DIR'

/**
 * The folder of source pictures.
 * @param env - the environment, for tests.
 * @param mustExist - false when the caller creates the folder, as the picture import does.
 * @returns the absolute path.
 * @throws Error naming the variable when it is unset, or when it names a folder that does not exist and `mustExist` holds.
 */
export function picturesDir(env: Readonly<Record<string, string | undefined>> = process.env, mustExist = true): string {
  const value = env[PICTURES_VARIABLE]
  if (value === undefined || value === '') throw new Error(`${PICTURES_VARIABLE} is not set. Set it to the folder of source pictures (for example ~/site-pictures); the screenshots are not in the repository.`)
  const path = resolve(value)
  if (mustExist && !existsSync(path)) throw new Error(`${PICTURES_VARIABLE} names ${path}, which does not exist. Set it to the folder of source pictures.`)
  return path
}
