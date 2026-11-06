/**
 * The root and timestamp signing commands, with throwaway keys generated in the test: a root rotation is written
 * only when both root thresholds sign it, and a timestamp names a channel's manifest only when the targets key signed
 * it, with its key taken from the environment.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signEnvelope } from '../../src/sign/envelope.ts'
import { toJsonValue } from '../../src/sign/json.ts'
import { readEnvelope } from '../../src/sign/schemas.ts'
import { readTrustedRoot } from '../../src/sign/verify.ts'
import { runEntry, scratch } from '../support.ts'
import { manifestContent, rootFile, throwawayKeys } from './fixture.ts'

function pem(directory: string, name: string, key: KeyObject): string {
  const path = join(directory, name)
  writeFileSync(path, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  return path
}

/** Each case builds fixture releases or runs a command as a child process, which a loaded host slows. */
const CHILD_PROCESS_TIMEOUT = { timeout: 60_000 }

describe('sign-root', CHILD_PROCESS_TIMEOUT, () => {
  it('writes a rotation signed by the previous and the new root key, and refuses one the previous key did not sign', (test) => {
    const directory = scratch(test)
    const keys = throwawayKeys()
    const first = rootFile(keys)
    writeFileSync(join(directory, '1.root.json'), first.bytes)
    const newRoot = generateKeyPairSync('ed25519').privateKey
    const next = rootFile({ ...keys, root: newRoot }, { version: 2 }, [])
    writeFileSync(join(directory, 'draft.json'), JSON.stringify(next.metadata))
    const args = ['--draft', join(directory, 'draft.json'), '--previous', join(directory, '1.root.json')]
    const refused = runEntry('sign-root.ts', [...args, '--key', pem(directory, 'new.pem', newRoot), '--out', join(directory, 'refused.json')])
    expect(refused.stderr).toContain('previous root\'s keys')
    expect(refused.status).toBe(1)
    const signed = runEntry('sign-root.ts', [...args, '--key', pem(directory, 'old.pem', keys.root), '--key', join(directory, 'new.pem'), '--out', join(directory, '2.root.json')])
    expect(signed.status).toBe(0)
    expect(readTrustedRoot(readFileSync(join(directory, '2.root.json'))).version).toBe(2)
  })

  it('refuses a key file that its group or others can read', (test) => {
    const directory = scratch(test)
    const keys = throwawayKeys()
    writeFileSync(join(directory, 'draft.json'), JSON.stringify(rootFile(keys).metadata))
    const key = join(directory, 'root.pem')
    writeFileSync(key, keys.root.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o644 })
    const result = runEntry('sign-root.ts', ['--draft', join(directory, 'draft.json'), '--key', key, '--out', join(directory, 'out.json')])
    expect(result.stderr).toContain('readable by its owner only (chmod 600)')
    expect(result.status).toBe(1)
  })
})

describe('sign-timestamp', CHILD_PROCESS_TIMEOUT, () => {
  it('names a manifest the targets key signed, and refuses one another key signed', (test) => {
    const directory = scratch(test)
    const keys = throwawayKeys()
    const root = rootFile(keys)
    writeFileSync(join(directory, 'root.json'), root.bytes)
    const draft = manifestContent('0.1.0', Buffer.from('archive'))
    const manifest = (signer: typeof keys.targets): string => `${JSON.stringify(signEnvelope({ signed: toJsonValue(draft), signatures: [] }, [signer]), undefined, 2)}\n`
    writeFileSync(join(directory, 'delorun-0.1.0.manifest.json'), manifest(keys.targets))
    const env = { DELO_TIMESTAMP_KEY: keys.timestamp.export({ format: 'pem', type: 'pkcs8' }).toString() }
    const args = ['--root', join(directory, 'root.json'), '--manifest', join(directory, 'delorun-0.1.0.manifest.json'), '--channel', 'stable', '--out', join(directory, 'timestamp.json')]
    const signed = runEntry('sign-timestamp.ts', args, env)
    expect(signed.stderr).toBe('')
    expect(signed.status).toBe(0)
    const timestamp = readEnvelope('timestamp', readFileSync(join(directory, 'timestamp.json'))).signed
    expect(timestamp.channels.stable.release).toBe('0.1.0')
    expect(timestamp.version).toBe(1)
    writeFileSync(join(directory, 'delorun-0.1.0.manifest.json'), manifest(keys.timestamp))
    const refused = runEntry('sign-timestamp.ts', args, env)
    expect(refused.stderr).toContain('0 valid signatures')
    expect(refused.status).toBe(1)
    expect(runEntry('sign-timestamp.ts', args, { DELO_TIMESTAMP_KEY: '' }).stderr).toContain('DELO_TIMESTAMP_KEY holds no key')
  })
})
