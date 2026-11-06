/**
 * The digests of plugin audit findings the user accepted, per package, kept in
 * the profile's `.plugin-manager/audits.json` at mode 0600. The manager passes
 * a package's accepted digests to the `pluginAudit` service, which lets a
 * change go on only for findings whose digest the user accepted. A file that
 * is missing or not this record reads as no acceptance, so findings ask again.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** The most digests kept for one package; the oldest are forgotten first. */
const KEPT_DIGESTS = 8

/**
 * Where a profile keeps the acceptances.
 * @param dir The profile directory.
 * @returns The record's path.
 */
export function auditAcceptancesPath(dir: string): string {
  return join(dir, '.plugin-manager', 'audits.json')
}

async function readAcceptances(dir: string): Promise<Record<string, string[]>> {
  let text: string
  try {
    text = await readFile(auditAcceptancesPath(dir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // A record that is not JSON accepted nothing; the next acceptance replaces it.
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([name, digests]) =>
    Array.isArray(digests) ? [[name, digests.filter((digest): digest is string => typeof digest === 'string')]] : []))
}

/**
 * The digests the user accepted for a package.
 * @param dir The profile directory.
 * @param name The package's name.
 * @returns The digests, the newest last.
 */
export async function acceptedAudits(dir: string, name: string): Promise<string[]> {
  return (await readAcceptances(dir))[name] ?? []
}

/**
 * Save the user's acceptance of a package's findings; the caller holds the profile manifest lock.
 * @param dir The profile directory.
 * @param name The package's name.
 * @param digest The findings' digest.
 */
export async function acceptAudit(dir: string, name: string, digest: string): Promise<void> {
  const all = await readAcceptances(dir)
  all[name] = [...(all[name] ?? []).filter(each => each !== digest), digest].slice(-KEPT_DIGESTS)
  await mkdir(dirname(auditAcceptancesPath(dir)), { recursive: true, mode: 0o700 })
  await writeFileAtomic(auditAcceptancesPath(dir), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
}
