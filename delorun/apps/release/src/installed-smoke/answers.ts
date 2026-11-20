/**
 * The setup answers the installed smoke feeds `delorun setup --config`: the release under test reads the current
 * schema version, and the previous release that step 6 installs reads an earlier one.
 *
 * @module @delorun/release/installed-smoke/answers
 */

/** The schema version the release under test writes and reads (`SETUP_ANSWERS_SCHEMA_VERSION` of `@delorun/contract-setup-answers`). */
export const SMOKE_ANSWERS_SCHEMA_VERSION = 5

/**
 * The schema version step 6 gives the previous release: the highest one every release since version 4 reads. A release
 * before version 5 refuses 5 ("schemaVersion must be 4, or 2 or 3"), and a later one reads 4 as an earlier document.
 */
export const PREVIOUS_RELEASE_ANSWERS_SCHEMA_VERSION = 4

/**
 * One answers document: a local setup with no model provider, Safer prompts, no remote access, no stock home import,
 * changes unprotected and update checks off, on the smoke's studio port. Neither version needs `phonePowers`.
 * @param schemaVersion - the document's schema version.
 * @param studioPort - the studio port of the smoke's profile.
 * @returns the document as one line of JSON with its newline.
 */
export function smokeAnswers(schemaVersion: typeof SMOKE_ANSWERS_SCHEMA_VERSION | typeof PREVIOUS_RELEASE_ANSWERS_SCHEMA_VERSION, studioPort: number): string {
  return `${JSON.stringify({
    schemaVersion,
    useCase: 'local',
    modelProvider: null,
    prompts: 'safer',
    background: true,
    profile: { name: null, port: studioPort },
    reach: { option: 'none', identityFactor: null },
    importStockHome: false,
    protectChanges: false,
    updateCheck: false,
  })}\n`
}
