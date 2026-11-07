/**
 * The root and timestamp signing commands, with throwaway keys generated in the test: a root rotation is written
 * only when both root thresholds sign it, and a timestamp names a channel's manifest only when the targets key signed
 * it and the previous timestamp verifies, with its key taken from the environment.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { UtcTimestamp } from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { signEnvelope } from '../../src/sign/envelope.ts'
import { toJsonValue } from '../../src/sign/json.ts'
import { readEnvelope } from '../../src/sign/schemas.ts'
import { trustRootChain } from '../../src/sign/verify.ts'
import { runEntry, scratch } from '../support.ts'
import { manifestContent, rootFile, throwawayKeys } from './fixture.ts'

function pem(directory: string, name: string, key: KeyObject): string {
  const path = join(directory, name)
  writeFileSync(path, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  return path
}

/** Each case builds fixture releases or runs a command as a child process, which a loaded host slows. */
const CHILD_PROCESS_TIMEOUT = { timeout: 60_000 }

function utc(seconds: number): UtcTimestamp {
  return brandString<UtcTimestamp>(`${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`)
}

/** Root dates around the real clock, which the commands read. */
function window(): { issued: UtcTimestamp, expires: UtcTimestamp } {
  const now = Math.floor(Date.now() / 1000)
  return { issued: utc(now - 86_400), expires: utc(now + 300 * 86_400) }
}

describe('sign-root', CHILD_PROCESS_TIMEOUT, () => {
  it('writes a rotation signed by the previous and the new root key, and refuses one the previous key did not sign', (test) => {
    const directory = scratch(test)
    const keys = throwawayKeys()
    const first = rootFile(keys, window())
    writeFileSync(join(directory, '1.root.json'), first.bytes)
    const newRoot = generateKeyPairSync('ed25519').privateKey
    const next = rootFile({ ...keys, root: newRoot }, { version: 2, ...window() }, [])
    writeFileSync(join(directory, 'draft.json'), JSON.stringify(next.metadata))
    const args = ['--draft', join(directory, 'draft.json'), '--previous', join(directory, '1.root.json')]
    const refused = runEntry('sign-root.ts', [...args, '--key', pem(directory, 'new.pem', newRoot), '--out', join(directory, 'refused.json')])
    expect(refused.stderr).toContain('previous root\'s keys')
    expect(refused.status).toBe(1)
    const signed = runEntry('sign-root.ts', [...args, '--key', pem(directory, 'old.pem', keys.root), '--key', join(directory, 'new.pem'), '--out', join(directory, '2.root.json')])
    expect(signed.status).toBe(0)
    expect(trustRootChain([first.bytes, readFileSync(join(directory, '2.root.json'))], Math.floor(Date.now() / 1000)).at(-1)!.metadata.version).toBe(2)
  })

  it('refuses a key file that its group or others can read', (test) => {
    const directory = scratch(test)
    const keys = throwawayKeys()
    writeFileSync(join(directory, 'draft.json'), JSON.stringify(rootFile(keys, window()).metadata))
    const key = join(directory, 'root.pem')
    writeFileSync(key, keys.root.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o644 })
    const result = runEntry('sign-root.ts', ['--draft', join(directory, 'draft.json'), '--key', key, '--out', join(directory, 'out.json')])
    expect(result.stderr).toContain('readable by its owner only (chmod 600)')
    expect(result.status).toBe(1)
  })
})

describe('sign-timestamp', CHILD_PROCESS_TIMEOUT, () => {
  it('starts from a state written once, continues only from the timestamp it records, and refuses a manifest another key signed', (test) => {
    const directory = scratch(test)
    const keys = throwawayKeys()
    const root = rootFile(keys, window())
    const rootPath = join(directory, 'root.json')
    writeFileSync(rootPath, root.bytes)
    const statePath = join(directory, 'state.json')
    expect(runEntry('sign-timestamp.ts', ['--init-state', '--root', rootPath, '--state', statePath]).status).toBe(0)
    const again = runEntry('sign-timestamp.ts', ['--init-state', '--root', rootPath, '--state', statePath])
    expect(again.stderr).toContain('exists; the state is written once')
    const manifest = (version: string, signer: typeof keys.targets): string => {
      const path = join(directory, `delorun-${version}.manifest.json`)
      writeFileSync(path, `${JSON.stringify(signEnvelope({ signed: toJsonValue(manifestContent(version, Buffer.from('archive'))), signatures: [] }, [signer]), undefined, 2)}\n`)
      return path
    }
    const older = manifest('0.1.0', keys.targets)
    const env = { DELO_TIMESTAMP_KEY: keys.timestamp.export({ format: 'pem', type: 'pkcs8' }).toString() }
    const sign = (out: string, start: readonly string[], path = older): ReturnType<typeof runEntry> => runEntry('sign-timestamp.ts', ['--state', statePath, '--root', rootPath, ...start, '--stable', path, '--beta', path, '--out', join(directory, out)], env)
    expect(sign('none.json', []).stderr).toContain('pass exactly one of --previous <timestamp.json> and --first')
    const first = sign('t1.json', ['--first'])
    expect(first.stderr).toBe('')
    expect(first.status).toBe(0)
    expect(readEnvelope('timestamp', readFileSync(join(directory, 't1.json'))).signed.version).toBe(1)
    expect(sign('first-again.json', ['--first']).stderr).toContain('the state records timestamp 1 as the last signed')
    const newer = manifest('0.2.0', keys.targets)
    expect(sign('t2.json', ['--previous', join(directory, 't1.json')], newer).status).toBe(0)
    const rollback = sign('rollback.json', ['--previous', join(directory, 't1.json')])
    expect(rollback.stderr).toContain('the last timestamp signed (version 2) as the state records')
    expect(rollback.status).toBe(1)
    expect(existsSync(join(directory, 'rollback.json'))).toBe(false)
    expect(sign('t3.json', ['--previous', join(directory, 't2.json')], newer).status).toBe(0)
    const forged = sign('forged.json', ['--previous', join(directory, 't3.json')], manifest('0.3.0', keys.timestamp))
    expect(forged.stderr).toContain('0 valid signatures')
    expect(forged.status).toBe(1)
    expect(runEntry('sign-timestamp.ts', ['--state', statePath, '--root', rootPath, '--previous', join(directory, 't3.json'), '--stable', newer, '--beta', newer, '--out', join(directory, 'x.json')], { DELO_TIMESTAMP_KEY: '' }).stderr).toContain('DELO_TIMESTAMP_KEY holds no key')
  })
})
