import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { replicaPlugins } from '../src/replica/build/plugins.ts'
import { STUDIO_ALIASES } from '../studio-aliases.ts'

const RELEASE = '0.1.0-preview.2'
const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A session module the plugin checks: only the fields `sessionRefusals` reads. */
function session(id: string, fields: { standIn: boolean; release: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'replica-guard-'))
  dirs.push(dir)
  const file = join(dir, `${id}.session.ts`)
  writeFileSync(file, `export const FIXTURE = ${JSON.stringify({ id, ...fields })}\n`)
  return file
}

interface Hooks {
  configResolved(config: { command: string; isProduction: boolean }): void
  buildStart(this: { error(message: string): never }): Promise<void>
}

/** Runs the plugin's hooks the way Vite does for a build or a serve. */
async function run(sessionFiles: readonly string[], options: { command: 'build' | 'serve'; release?: string | undefined } = { command: 'build' }): Promise<void> {
  const [plugin] = replicaPlugins({ aliases: STUDIO_ALIASES, release: 'release' in options ? options.release : RELEASE, sessionFiles })
  const hooks = plugin as Hooks
  hooks.configResolved({ command: options.command, isProduction: options.command === 'build' })
  await hooks.buildStart.call({ error: (message: string) => { throw new Error(message) } })
}

describe('a production build\'s refusal of stand-in sessions', () => {
  it('refuses a stand-in unless the variable is exactly 1', async () => {
    const files = [session('a', { standIn: true, release: RELEASE })]
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      if (value === undefined) vi.stubEnv('SITE_ALLOW_STANDINS', undefined as never)
      else vi.stubEnv('SITE_ALLOW_STANDINS', value)
      await expect(run(files), String(value)).rejects.toThrow(/hand-made stand-in/)
    }
    vi.stubEnv('SITE_ALLOW_STANDINS', '1')
    await expect(run(files)).resolves.toBeUndefined()
  })

  it('builds without the variable when every session is a recording made on the marketed release', async () => {
    vi.stubEnv('SITE_ALLOW_STANDINS', undefined as never)
    await expect(run([session('a', { standIn: false, release: RELEASE }), session('b', { standIn: false, release: RELEASE })])).resolves.toBeUndefined()
  })

  it('refuses a recording made on another release without the variable', async () => {
    vi.stubEnv('SITE_ALLOW_STANDINS', undefined as never)
    await expect(run([session('a', { standIn: false, release: '0.1.0-preview.1' })])).rejects.toThrow(/recorded on 0\.1\.0-preview\.1/)
  })

  it('refuses a build with no release to market, and checks nothing on a development server', async () => {
    const files = [session('a', { standIn: true, release: RELEASE })]
    await expect(run(files, { command: 'build', release: undefined })).rejects.toThrow(/needs `release`/)
    await expect(run(files, { command: 'serve' })).resolves.toBeUndefined()
  })
})
