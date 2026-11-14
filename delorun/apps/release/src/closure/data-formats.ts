/**
 * The runtime closure's `data-formats.json` (contract C3, "Data formats"): the digest of upstream's
 * `docs/persistence-schema.json` at the built commit and the versions of Delorun's own records under the home, written
 * at the root of each platform's staged closure so the signed file list carries it. An update compares two releases'
 * files to decide whether they read each other's chat data.
 *
 * @module @delorun/release/closure/data-formats
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_FORMATS_FILE } from '@delorun/contract-update-report'
import { dataFormatsOf, dataFormatsText } from '@delorun/update/data-formats'

/** Upstream's schema inventory, relative to the checkout's root. */
export const PERSISTENCE_SCHEMA_PATH = 'docs/persistence-schema.json'

/**
 * Write `data-formats.json` at the root of a staged closure.
 * @param stage - the platform's staged tree, which the archive and file list are made from.
 * @param source - the exported checkout of the built commit.
 * @returns the path written.
 * @throws {Error} when the checkout has no schema inventory or the file already exists in the stage.
 */
export async function writeDataFormats(stage: string, source: string): Promise<string> {
  const formats = dataFormatsOf(await readFile(join(source, PERSISTENCE_SCHEMA_PATH)))
  const path = join(stage, DATA_FORMATS_FILE)
  await writeFile(path, dataFormatsText(formats), { flag: 'wx', mode: 0o644 })
  return path
}
