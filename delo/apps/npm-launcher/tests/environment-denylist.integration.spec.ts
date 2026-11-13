/**
 * One environment denylist: every variable the launcher drops from the runtime's environment (`DROPPED_ENV` in
 * `src/bin.ts`) is also refused when a `.env` the runtime discovers sets it, by upstream's `loadLayeredEnv`, which stops
 * the launch before applying any value. A workspace `.env` that arrives with a clone therefore cannot set OpenSSL's
 * configuration, the C library's converters, Node's ICU data or any other dropped variable inside the runtime.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DROPPED_ENV } from '../src/bin.ts'

/**
 * One concrete name per alternative of the launcher's pattern: the name itself, or a name under a prefix.
 * @returns the names.
 */
function droppedNames(): string[] {
  const alternatives = /^\^\(\?:(.*)\)\$$/u.exec(DROPPED_ENV.source)?.[1]?.split('|') ?? []
  return alternatives.map(alternative => alternative.endsWith('.*') ? `${alternative.slice(0, -2)}DENYLIST_PROBE` : alternative)
}

const directories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the environment denylist', () => {
  it('reads every alternative of the launcher\'s pattern', () => {
    expect(droppedNames()).toEqual(expect.arrayContaining(['OPENSSL_CONF', 'GCONV_PATH', 'NODE_ICU_DATA', 'LD_DENYLIST_PROBE', 'DYLD_DENYLIST_PROBE']))
    expect(droppedNames().every(name => DROPPED_ENV.test(name))).toBe(true)
  })

  it.each(droppedNames())('refuses %s from a workspace .env before applying any value', (name) => {
    const home = mkdtempSync(join(tmpdir(), 'denylist-home-'))
    const workspace = mkdtempSync(join(tmpdir(), 'denylist-workspace-'))
    directories.push(home, workspace)
    writeFileSync(join(workspace, '.env'), `DENYLIST_APPLIED=yes\n${name}=/tmp/planted\n`)
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv(name, undefined)
    vi.stubEnv('DENYLIST_APPLIED', undefined)
    expect(() => loadLayeredEnv('delorun', workspace, () => undefined)).toThrow(/only the launching environment may set/u)
    expect(process.env.DENYLIST_APPLIED).toBeUndefined()
    expect(process.env[name]).toBeUndefined()
  })
})
