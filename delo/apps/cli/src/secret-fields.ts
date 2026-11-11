/**
 * Contract C1 keeps every secret out of patch files. A plugin field whose Config schema has the role `secret`, such as
 * the DeepSeek API key fields of upstream's web search plugins, holds a credential, and the profile's patch files are
 * saved in git by the profile history; Delo keeps such a value in upstream's credentials file under the home instead,
 * where the studio's key fields and `delorun setup` write it. Over a booted Host this module:
 *
 * - refuses a configuration edit, from the studio's Settings, the agent's `configure` action or any other caller of
 *   upstream's configuration editor, that would save a value for a secret-role field into the profile patch, before
 *   the file is written (`config-editor/before-save`);
 * - refuses to save a profile history version whose patch holds such a value (`plugin-manager/before-record`), so an
 *   edit made by hand never enters the history either;
 * - refuses a start whose profile patch or home patch already holds one, naming each place and how to move it.
 *
 * Only rows of loaded plugins are checked, because only a loaded plugin's schema says which fields are secret.
 *
 * @module @delo/cli/secret-fields
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { describeSecretField, describeSecretValues, secretFieldAdmission, secretFieldsSet, secretValuesInPatch, type ConfigSchemasOf } from '@delo/profile-safety'
import { CliError, EXIT } from './exit.ts'
import { profileDirectory } from './profile.ts'
import { CREDENTIALS_FILENAME } from './setup/writes.ts'

/** The patch file of a profile and of the home. */
const PATCH_FILENAME = 'cordis.patch.yml'

/**
 * The Config schemas of a booted Host's Loader rows, read when asked, so a plugin loaded or replaced later counts.
 * @param ctx - the booted profile's root context.
 * @returns the lookup by row id; empty for a row id no loaded row has.
 */
export function configSchemasOf(ctx: Context): ConfigSchemasOf {
  return (entryId) => {
    const loader = ctx.get('loader')
    if (loader === undefined) return []
    return [...loader.entries()].filter(entry => entry.options.id === entryId).flatMap((entry) => {
      const schema: unknown = entry.fiber?.runtime?.Config
      return schema === undefined ? [] : [schema]
    })
  }
}

/**
 * Refuse configuration edits and profile history versions that would save a value for a secret-role field, for as long
 * as the booted Host runs: both listeners are effects of `ctx`.
 * @param ctx - the booted profile's root context.
 * @param schemas - its Config schemas ({@link configSchemasOf}).
 */
export function guardSecretFields(ctx: Context, schemas: ConfigSchemasOf): void {
  ctx.on('config-editor/before-save', ({ entry, config }) => {
    const fields = secretFieldsSet(config, schemas(entry.options.id))
    if (fields.length === 0) return undefined
    const named = fields.map(field => describeSecretField(entry.options.id, field)).join(' and ')
    return `Delo keeps secrets out of the profile's settings file, which the profile history saves in git, so this change was not saved: it would write a value for ${named}. Enter the key in the studio's key field for it, or store it in the credentials file under a name and name it in the plugin's credential field; if the profile file already holds the value, delete it there.`
  })
  ctx.on('plugin-manager/before-record', secretFieldAdmission(schemas))
}

/**
 * Refuse a start whose profile patch or home patch holds a value for a secret-role field of a loaded plugin. The
 * refusal names each place, never the value, and how to move it into the credentials file.
 * @param home - the Delo home.
 * @param profile - the profile that started.
 * @param schemas - the booted Host's Config schemas ({@link configSchemasOf}).
 * @param command - the command that starts the refusal's message.
 * @throws {CliError} `EXIT.failed` when a patch holds such a value.
 */
export function assertNoSecretValues(home: string, profile: string, schemas: ConfigSchemasOf, command: string): void {
  const places = [join(profileDirectory(home, profile), PATCH_FILENAME), join(home, PATCH_FILENAME)].flatMap(path =>
    existsSync(path) ? secretValuesInPatch(path, readFileSync(path, 'utf8'), schemas) : [])
  if (places.length === 0) return
  const credentials = join(home, CREDENTIALS_FILENAME)
  throw new CliError(EXIT.failed, `${command}: the profile ${profile} did not start because a patch file holds a secret: ${describeSecretValues(places)}. Delo keeps secrets out of patch files, which the profile history saves in git. Move each value into ${credentials}: add it under refs as a name such as MY_SEARCH_KEY (delorun setup stores the DeepSeek API key as DEEPSEEK_API_KEY), set the plugin's credential field to that name where it has one, delete the value from the patch file, then start again. If an earlier Delo saved the patch in the profile history, also replace the key with a new one.`)
}
