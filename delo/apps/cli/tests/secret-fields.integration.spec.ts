/**
 * Contract C1's `secret-field-refused` denial test, of the rule that no secret is written to a patch file: over a booted Host with upstream's
 * configuration editor and Settings service, a value for a secret-role field saved from Settings writes nothing to the
 * profile patch or its history, a hand-edited value is refused by the history, and a start over a patch that holds one
 * is refused. The history is upstream's git-backed one, so the specs run git.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { HISTORY_DIR, PROFILE_FILES, ProfileHistory } from '@deepseek-ai/dsh-plugin-manager/history'
import Settings from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { CliError } from '../src/exit.ts'
import { assertNoSecretValues, configSchemasOf, guardSecretFields } from '../src/secret-fields.ts'

/** The secret value the specs type; no file the specs read may hold it. */
const SECRET = 'sk-typed-into-settings'

/** A plugin with the Config of upstream's DeepSeek web plugins. */
const WebPlugin = {
  Config: z.object({
    apiKey: z.string().role('secret').volatile(),
    apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
    count: z.number().default(10).volatile(),
  }),
  apply: () => {},
}

let home: string
let profile: ProfileContext
let ctx: Context

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'delo-secret-fields-')))
  const dir = join(home, 'profiles', 'default')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'web-deepseek-api', name: 'cordis:web' },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  profile = {
    name: 'default', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx = await boot('default', join(dir, 'cordis.yml'), readProfilePatches('default', profile), (root) => {
    root.provide('profileContext', profile)
    root.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: Settings, web: WebPlugin })
  })
  guardSecretFields(ctx, configSchemasOf(ctx))
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

/**
 * The profile history as upstream's plugin manager opens it, asking `plugin-manager/before-record` before each version.
 * @returns the history.
 */
function history(): ProfileHistory {
  return new ProfileHistory(profile.dir, PROFILE_FILES, 'git', 30_000, files => ctx.bail('plugin-manager/before-record', files))
}

/**
 * @returns every version of the history with its full patch, as one text.
 */
function historyText(): string {
  return execFileSync('git', ['--git-dir', join(profile.dir, HISTORY_DIR), 'log', '--all', '-p'], { encoding: 'utf8', timeout: 30_000 })
}

describe('saving from Settings', () => {
  it('refuses a value for a secret-role field and writes nothing secret to the profile patch or its history', async () => {
    const versions = history()
    const first = await versions.record('Before', { kind: 'person' })
    const before = readFileSync(profile.patchPath, 'utf8')
    const refused = await ctx.settings.mutate('web-deepseek-api', [{ op: 'set', path: ['apiKey'], value: SECRET }]).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toBe('Delo keeps secrets out of the profile\'s settings file, which the profile history saves in git, so this change was not saved: it would write a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead). Enter the key in the studio\'s key field for it, or store it in the credentials file under a name and name it in the plugin\'s credential field; if the profile file already holds the value, delete it there.')
    await expect(ctx.settings.update('web-deepseek-api', { apiKey: SECRET })).rejects.toThrow('Delo keeps secrets out of the profile\'s settings file')
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
    expect(await versions.record('After', { kind: 'person' })).toBeUndefined()
    expect((await versions.list(10)).map(version => version.id)).toEqual([first])
    expect(historyText()).not.toContain(SECRET)
  })

  it('saves the credential reference and other fields of the same plugin', async () => {
    await ctx.settings.mutate('web-deepseek-api', [{ op: 'set', path: ['apiKeyEnv'], value: 'MY_SEARCH_KEY' }, { op: 'set', path: ['count'], value: 5 }])
    expect(readFileSync(profile.patchPath, 'utf8')).toContain('MY_SEARCH_KEY')
    expect(await history().record('Reference', { kind: 'person' })).toMatch(/^[0-9a-f]{40}$/u)
  })
})

describe('a value written into the patch by hand', () => {
  it('is refused by the history, which saves no version until it is gone', async () => {
    const versions = history()
    const first = await versions.record('Before', { kind: 'person' })
    writeFileSync(profile.patchPath, `- id: web-deepseek-api\n  config:\n    apiKey: ${SECRET}\n`)
    await expect(versions.record('Hand edit', { kind: 'outside' })).rejects.toThrow('this version of the profile was not saved: cordis.patch.yml holds a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead).')
    expect((await versions.list(10)).map(version => version.id)).toEqual([first])
    writeFileSync(profile.patchPath, '- id: web-deepseek-api\n  config:\n    apiKey: !!js process.env.SEARCH_KEY\n')
    expect(await versions.record('Expression', { kind: 'outside' })).toMatch(/^[0-9a-f]{40}$/u)
    expect(historyText()).not.toContain(SECRET)
  })

  it('refuses the start, naming the file and the field and never the value', () => {
    assertNoSecretValues(home, 'default', configSchemasOf(ctx), 'delorun')
    writeFileSync(join(home, 'cordis.patch.yml'), `- id: web-deepseek-api\n  config: { apiKey: ${SECRET} }\n`)
    const refusal = ((): unknown => {
      try {
        assertNoSecretValues(home, 'default', configSchemasOf(ctx), 'delorun')
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(refusal).toBeInstanceOf(CliError)
    const message = (refusal as CliError).message
    expect(message).toContain(`delorun: the profile default did not start because a patch file holds a secret: ${join(home, 'cordis.patch.yml')} holds a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead).`)
    expect(message).toContain(`Move each value into ${join(home, '.credentials.yaml')}`)
    expect(message).not.toContain(SECRET)
  })
})
