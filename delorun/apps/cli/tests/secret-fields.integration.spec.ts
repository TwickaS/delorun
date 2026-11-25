/**
 * Contract C1's `secret-field-refused` denial test, of the rule that no secret is written to a patch file: over a
 * booted Host with upstream's configuration editor, Settings service and local credentials store, a value for a
 * secret-role field saved from Settings writes nothing to the profile patch or its history, a value written into the
 * patch by hand, as a literal or as a `!!js` expression that is not an environment read, is refused by the history,
 * and the start moves a value a patch already holds into the credentials store, or names it when it cannot. The history
 * is upstream's git-backed one, so the specs run git.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { HISTORY_DIR, PROFILE_FILES, ProfileHistory, VersionRefusedError } from '@deepseek-ai/dsh-plugin-manager/history'
import Settings from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { parse } from 'yaml'
import { configSchemasOf, credentialNameFor, guardSecretFields, MAX_NAME_ATTEMPTS, settleSecretValues, type SecretSettlement } from '../src/secret-fields.ts'
import { PROFILE_LOCK_WAIT_MS } from '@delorun/changes'

/** The secret value the specs type; no file the history holds and no message may hold it. */
const SECRET = 'sk-typed-into-settings'

/** A plugin with the Config of upstream's DeepSeek web plugins: a literal key and the reference beside it. */
const WebPlugin = {
  Config: z.object({
    apiKey: z.string().role('secret').volatile(),
    apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
    count: z.number().default(10).volatile(),
  }),
  apply: () => {},
}

/** A plugin whose secret field has no reference field beside it. */
const HeadersPlugin = {
  Config: z.object({ requestHeaders: z.dict(z.string().role('secret')).default({}) }),
  apply: () => {},
}

let home: string
let profile: ProfileContext
let ctx: Context
let credentials: string

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-secret-fields-')))
  credentials = join(home, '.credentials.yaml')
  const dir = join(home, 'profiles', 'default')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'credentials', name: 'cordis:credentials', config: { path: credentials, watch: false } },
    { id: 'web-deepseek-api', name: 'cordis:web' },
    { id: 'headers', name: 'cordis:headers' },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  profile = {
    name: 'default', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  await start()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** Boot the fixture profile, with the guard registered before the Loader mounts a row, as `delorun` registers it. */
async function start(): Promise<void> {
  ctx = await boot('default', join(profile.dir, 'cordis.yml'), readProfilePatches('default', profile), (root) => {
    root.provide('profileContext', profile)
    root.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    root.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: Settings, credentials: LocalCredentialProvider, web: WebPlugin, headers: HeadersPlugin })
    guardSecretFields(root, configSchemasOf(root))
  })
}

/**
 * The profile history as upstream's plugin manager opens it, asking `plugin-manager/before-record` before each version.
 * @returns the history.
 */
function history(): ProfileHistory {
  return new ProfileHistory(profile.dir, PROFILE_FILES, 'git', 30_000, files => ctx.bail('plugin-manager/before-record', files))
}

/** @returns every version of the history with its full patch, as one text. */
function historyText(): string {
  return execFileSync('git', ['--git-dir', join(profile.dir, HISTORY_DIR), 'log', '--all', '-p'], { encoding: 'utf8', timeout: 30_000 })
}

/**
 * Settle the profile's patch files, as a start does.
 * @returns what settling did, with no line that holds the secret.
 */
async function settle(): Promise<SecretSettlement> {
  const settled = await settleSecretValues(ctx, home, 'default', configSchemasOf(ctx))
  for (const line of [...settled.moved, ...settled.notices]) expect(line).not.toContain(SECRET)
  return settled
}

/** @returns the credentials file's parsed document. */
function stored(): { version: number, refs: Record<string, string> } {
  return parse(readFileSync(credentials, 'utf8')) as { version: number, refs: Record<string, string> }
}

describe('saving from Settings', () => {
  it('refuses a value for a secret-role field and writes nothing secret to the profile patch or its history', async () => {
    const versions = history()
    const first = await versions.record('Before', { kind: 'person' })
    const before = readFileSync(profile.patchPath, 'utf8')
    const refused = await ctx.settings.mutate('web-deepseek-api', [{ op: 'set', path: ['apiKey'], value: SECRET }]).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Error)
    const message = (refused as Error).message
    expect(message).toContain('This change was not saved: it would write a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead) into the profile\'s settings file')
    expect(message).toContain('whose first line is `version: 1` and which lists keys under `refs:` as `NAME: <key>`, NAME being a POSIX identifier')
    expect(message).not.toContain('studio')
    expect(message).not.toContain(SECRET)
    const update = await ctx.settings.update('web-deepseek-api', { apiKey: SECRET }).catch((error: unknown) => error)
    expect((update as Error).message).toContain('This change was not saved')
    expect((update as Error).message).not.toContain(SECRET)
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
    expect(await versions.record('After', { kind: 'person' })).toBeUndefined()
    expect((await versions.list(10)).map(version => version.id)).toEqual([first])
    expect(historyText()).not.toContain(SECRET)
  })

  it('saves the credential reference and other fields of the same plugin, and treats an empty key as unset', async () => {
    await ctx.settings.mutate('web-deepseek-api', [{ op: 'set', path: ['apiKeyEnv'], value: 'MY_SEARCH_KEY' }, { op: 'set', path: ['count'], value: 5 }, { op: 'set', path: ['apiKey'], value: '' }])
    expect(readFileSync(profile.patchPath, 'utf8')).toContain('MY_SEARCH_KEY')
    expect(await history().record('Reference', { kind: 'person' })).toMatch(/^[0-9a-f]{40}$/u)
  })
})

describe('a value written into the patch by hand', () => {
  it('is refused by the history as a literal or a `!!js` expression, and admitted as an environment read', async () => {
    const versions = history()
    const first = await versions.record('Before', { kind: 'person' })
    for (const value of [SECRET, `!!js "'${SECRET}'"`]) {
      writeFileSync(profile.patchPath, `- id: web-deepseek-api\n  config:\n    apiKey: ${value}\n`)
      const refused = await versions.record('Hand edit', { kind: 'outside' }).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(VersionRefusedError)
      expect((refused as Error).message).toContain('cordis.patch.yml holds a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead).')
      expect((refused as Error).message).not.toContain(SECRET)
    }
    expect((await versions.list(10)).map(version => version.id)).toEqual([first])
    writeFileSync(profile.patchPath, '- id: web-deepseek-api\n  config:\n    apiKey: !!js process.env.SEARCH_KEY\n')
    expect(await versions.record('Environment read', { kind: 'outside' })).toMatch(/^[0-9a-f]{40}$/u)
    expect(historyText()).not.toContain(SECRET)
  })
})

describe('settling a start\'s patch files', () => {
  it('moves a key to a new name and points the reference field at it when the default name holds another key', async () => {
    writeFileSync(credentials, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-the-model-key\n  ${credentialNameFor('web-deepseek-api', ['apiKey'])}: sk-another-key\n`, { mode: 0o600 })
    await ctx.fiber.dispose()
    await start()
    writeFileSync(profile.patchPath, `# the person's note\n- id: web-deepseek-api\n  config:\n    apiKey: ${SECRET}\n    count: 3\n`)
    const settled = await settle()
    expect(settled).toEqual({
      moved: [`${profile.patchPath}: moved the value of the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead) into the credentials file as WEB_DEEPSEEK_API_APIKEY_2, and set apiKeyEnv to WEB_DEEPSEEK_API_APIKEY_2.`],
      notices: [],
    })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe('# the person\'s note\n- id: web-deepseek-api\n  config:\n    count: 3\n    apiKeyEnv: WEB_DEEPSEEK_API_APIKEY_2\n')
    expect(stored().refs).toEqual({ DEEPSEEK_API_KEY: 'sk-the-model-key', WEB_DEEPSEEK_API_APIKEY: 'sk-another-key', WEB_DEEPSEEK_API_APIKEY_2: SECRET })
    expect(await history().record('After the move', { kind: 'person' })).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('only removes a key the credentials file already holds under the name the reference field gives', async () => {
    writeFileSync(credentials, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${SECRET}\n`, { mode: 0o600 })
    await ctx.fiber.dispose()
    await start()
    writeFileSync(join(home, 'cordis.patch.yml'), `- id: web-deepseek-api\n  config:\n    apiKey: ${SECRET}\n`)
    const settled = await settle()
    expect(settled.moved).toEqual([`${join(home, 'cordis.patch.yml')}: removed the value of the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead), because the credentials file already holds it as DEEPSEEK_API_KEY.`])
    expect(parse(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'))).toEqual([{ id: 'web-deepseek-api', config: {} }])
    expect(stored().refs).toEqual({ DEEPSEEK_API_KEY: SECRET })
  })

  it('moves the key of an inserted row without an id, found by its plugin name, and replaces a stale copy of the home patch', async () => {
    writeFileSync(profile.patchPath, `- insert:\n    - name: cordis:web\n      config:\n        apiKey: ${SECRET}\n        apiKeyEnv: MY_SEARCH_KEY\n`)
    writeFileSync(join(profile.dir, 'home-cordis.patch.yml'), `- id: web-deepseek-api\n  config:\n    apiKey: ${SECRET}\n`)
    writeFileSync(join(home, 'cordis.patch.yml'), '[]\n')
    const settled = await settle()
    expect(settled.moved).toEqual([
      `${profile.patchPath}: moved the value of the secret field apiKey of cordis:web (name a stored credential in apiKeyEnv instead) into the credentials file as CORDIS_WEB_APIKEY, and set apiKeyEnv to CORDIS_WEB_APIKEY.`,
      `${join(profile.dir, 'home-cordis.patch.yml')}: replaced with a copy of ${join(home, 'cordis.patch.yml')} as it is now.`,
    ])
    expect(readFileSync(profile.patchPath, 'utf8')).not.toContain(SECRET)
    expect(readFileSync(join(profile.dir, 'home-cordis.patch.yml'), 'utf8')).not.toContain(SECRET)
    expect(stored().refs).toEqual({ CORDIS_WEB_APIKEY: SECRET })
  })

  it('chooses a name from the credentials file as another process left it, never writing over that process\'s key', async () => {
    writeFileSync(profile.patchPath, `- id: web-deepseek-api\n  config:\n    apiKey: ${SECRET}\n`)
    // Written after this Host's store last read the file, as another start would write it.
    writeFileSync(credentials, `version: 1\nrefs:\n  ${credentialNameFor('web-deepseek-api', ['apiKey'])}: sk-another-start\n`, { mode: 0o600 })
    const settled = await settle()
    expect(settled.moved).toEqual([`${profile.patchPath}: moved the value of the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead) into the credentials file as WEB_DEEPSEEK_API_APIKEY_2, and set apiKeyEnv to WEB_DEEPSEEK_API_APIKEY_2.`])
    expect(stored().refs).toEqual({ WEB_DEEPSEEK_API_APIKEY: 'sk-another-start', WEB_DEEPSEEK_API_APIKEY_2: SECRET })
  })

  it(`leaves a value in place when the first ${String(MAX_NAME_ATTEMPTS)} names it could take all hold other keys`, async () => {
    const base = credentialNameFor('web-deepseek-api', ['apiKey'])
    const taken = Array.from({ length: MAX_NAME_ATTEMPTS }, (_, index) => `  ${index === 0 ? base : `${base}_${String(index + 1)}`}: sk-other-${String(index)}`)
    writeFileSync(credentials, `version: 1\nrefs:\n${taken.join('\n')}\n`, { mode: 0o600 })
    const text = `- id: web-deepseek-api\n  config:\n    apiKey: ${SECRET}\n`
    writeFileSync(profile.patchPath, text)
    const settled = await settle()
    expect(settled.moved).toEqual([])
    expect(settled.notices).toEqual([expect.stringContaining(`which Delorun left in place because storing it failed: no free credential name was found from ${base} to ${base}_${String(MAX_NAME_ATTEMPTS)}.`)])
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(text)
  })

  it('leaves a value with no reference field, or an expression, in place and names it with the way to move it', async () => {
    const text = `- id: headers\n  config:\n    requestHeaders:\n      Authorization: ${SECRET}\n- id: web-deepseek-api\n  config:\n    apiKey: !!js "'${SECRET}'"\n`
    writeFileSync(profile.patchPath, text)
    const settled = await settle()
    expect(settled.moved).toEqual([])
    expect(settled.notices).toEqual([
      `${profile.patchPath} holds a value for the secret field requestHeaders.Authorization of headers, which Delorun left in place because the plugin has no credential field to name a stored key. The profile history saves no new version until it is gone from the file. This field has no credential field beside it, so to give the plugin a key, export the key as an environment variable NAME where you start Delorun and set the field to \`!!js process.env.NAME\`.`,
      expect.stringContaining(`${profile.patchPath} holds a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead), which Delorun left in place because it is a \`!!js\` expression that does more than read an environment variable.`),
    ])
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(text)
  })
})

describe('the profile\'s writer lock', () => {
  /** The profile's writer lock, upstream's lock file beside the profile's `package.json`. */
  const lock = (): string => `${join(profile.dir, 'package.json')}.lock`

  it('settles under a profile lock this process holds already, instead of waiting for itself', async () => {
    writeFileSync(profile.patchPath, `- id: web-deepseek-api\n  config:\n    apiKey: ${SECRET}\n`)
    let held: SecretSettlement | undefined
    let lockStillHeld = false
    await withFileLock(join(profile.dir, 'package.json'), async () => {
      const started = Date.now()
      held = await settleSecretValues(ctx, home, 'default', configSchemasOf(ctx), { lockWaitMs: 60_000 })
      // A re-take would have waited out its whole bound; the settle of this process must not.
      expect(Date.now() - started).toBeLessThan(5_000)
      lockStillHeld = existsSync(lock())
    }, { waitMs: PROFILE_LOCK_WAIT_MS })
    expect(held?.notices).toEqual([])
    expect(held?.moved).toEqual([`${profile.patchPath}: moved the value of the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead) into the credentials file as WEB_DEEPSEEK_API_APIKEY, and set apiKeyEnv to WEB_DEEPSEEK_API_APIKEY.`])
    expect(readFileSync(profile.patchPath, 'utf8')).not.toContain(SECRET)
    // The caller's own hold ends with the caller: settling never removes a lock file it did not create.
    expect(lockStillHeld).toBe(true)
    expect(existsSync(lock())).toBe(false)
  })

  it('refuses to settle while another process holds the profile lock, and writes nothing', async () => {
    const text = `- id: web-deepseek-api\n  config:\n    apiKey: ${SECRET}\n`
    writeFileSync(profile.patchPath, text)
    // A live process that is not this one, as another Delorun writing the profile would be, holds the lock.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
    try {
      writeFileSync(lock(), `${String(holder.pid)}\n`, { mode: 0o600 })
      await expect(settleSecretValues(ctx, home, 'default', configSchemasOf(ctx), { lockWaitMs: 300 }))
        // The lock's record is JSON-encoded, so its trailing newline reads as an escape.
        .rejects.toThrow(`atomic-write: timed out waiting for the writer lock at ${lock()} (record "${String(holder.pid)}\\n")`)
      expect(readFileSync(profile.patchPath, 'utf8')).toBe(text)
      expect(existsSync(credentials)).toBe(false)
    } finally {
      holder.kill('SIGKILL')
      rmSync(lock(), { force: true })
    }
  })
})
