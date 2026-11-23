/**
 * The root draft and the root and timestamp signing commands, with throwaway keys generated in the test: a root draft
 * is composed from public key files only and signs into a root a client trusts, a root rotation is written
 * only when both root thresholds sign it, and a timestamp names a channel's manifest only when the targets key signed
 * it and the previous timestamp verifies, with its key taken from the environment.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { UtcTimestamp } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { NOTE_COSIGNATURE, NOTE_ED25519, verifierKey } from '@delorun/release-formats/log/note'
import { publicKeyEntry, signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { trustRootChain } from '@delorun/release-formats/sign/verify'
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

function publicPem(directory: string, name: string, key: KeyObject): string {
  const path = join(directory, name)
  writeFileSync(path, createPublicKey(key).export({ format: 'pem', type: 'spki' }))
  return path
}

describe('draft-root', CHILD_PROCESS_TIMEOUT, () => {
  /**
   * The draft command line over fresh throwaway keys.
   * @param directory - where the public key files go.
   * @returns the keys and the arguments, without `--out`.
   */
  function draftArgs(directory: string): { readonly keys: ReturnType<typeof throwawayKeys>, readonly args: string[] } {
    const keys = throwawayKeys()
    const log = generateKeyPairSync('ed25519').privateKey
    const witness = generateKeyPairSync('ed25519').privateKey
    return {
      keys,
      args: [
        '--root-key', publicPem(directory, 'root.pub.pem', keys.root),
        '--targets-key', publicPem(directory, 'targets.pub.pem', keys.targets),
        '--timestamp-key', publicPem(directory, 'timestamp.pub.pem', keys.timestamp),
        '--catalogue-key', publicPem(directory, 'catalogue.pub.pem', keys.catalogue),
        '--log-origin', 'log.example.test',
        '--log-vkey', verifierKey('log.example.test', NOTE_ED25519, log),
        '--witness', verifierKey('witness.example.test', NOTE_COSIGNATURE, witness),
        '--log-entry-key', `PKIX_ED25519_PH=${publicPem(directory, 'targets.pub.pem', keys.targets)}`,
        '--days', '90',
      ],
    }
  }

  it('composes a draft from public key files that sign-root signs into a root a client trusts', (test) => {
    const directory = scratch(test)
    const { keys, args } = draftArgs(directory)
    const drafted = runEntry('draft-root.ts', [...args, '--out', join(directory, 'draft.json')])
    expect(drafted.stdout).toContain('wrote the draft of root version 1')
    expect(drafted.status).toBe(0)
    const signed = runEntry('sign-root.ts', ['--draft', join(directory, 'draft.json'), '--key', pem(directory, 'root.pem', keys.root), '--out', join(directory, '1.root.json')])
    expect(signed.status).toBe(0)
    const root = trustRootChain([readFileSync(join(directory, '1.root.json'))], Math.floor(Date.now() / 1000)).at(-1)!.metadata
    expect(root.roles.targets.keys).toEqual([{ keyid: publicKeyEntry(keys.targets).keyid, status: 'active' }])
    expect(root.roles.root.keyids).toEqual([publicKeyEntry(keys.root).keyid])
    expect(root.witnesses).toEqual({ keys: [{ name: 'witness.example.test', vkey: args[args.indexOf('--witness') + 1] }], threshold: 1 })
    expect(Date.parse(root.expires) - Date.parse(root.issued)).toBe(90 * 86_400_000)
    const again = runEntry('draft-root.ts', [...args, '--out', join(directory, 'draft.json')])
    expect(again.stderr).toContain('EEXIST')
    expect(again.status).toBe(1)
  })

  it('refuses a private key file, a log key of another origin and a lifetime above 365 days, writing nothing', (test) => {
    const directory = scratch(test)
    const { keys, args } = draftArgs(directory)
    const out = join(directory, 'draft.json')
    const replace = (flag: string, value: string): string[] => args.map((arg, index) => (args[index - 1] === flag ? value : arg))
    const privateKey = runEntry('draft-root.ts', [...replace('--targets-key', pem(directory, 'targets.pem', keys.targets)), '--out', out])
    expect(privateKey.stderr).toContain('holds a private key; pass the public key')
    const otherLog = runEntry('draft-root.ts', [...replace('--log-origin', 'other.example.test'), '--out', out])
    expect(otherLog.stderr).toContain('--log-vkey names log.example.test, not the log origin other.example.test')
    const long = runEntry('draft-root.ts', [...replace('--days', '366'), '--out', out])
    expect(long.stderr).toContain('--days 366 is above the 365 days a root may live')
    for (const result of [privateKey, otherLog, long]) expect(result.status).toBe(1)
    expect(existsSync(out)).toBe(false)
  })
})

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

/**
 * A git repository whose `main` commits a production-keys registry, as the release branch does.
 * @param directory - where the repository is made.
 * @param keyids - the key ids the registry lists.
 * @returns the repository's path.
 */
function registryRepository(directory: string, keyids: readonly string[]): string {
  const repo = join(directory, 'repo')
  mkdirSync(join(repo, 'delorun', 'release'), { recursive: true })
  const git = (args: readonly string[]): void => {
    execFileSync('git', args, { cwd: repo, timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org' } })
  }
  git(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'delorun', 'release', 'production-keys.json'), `${JSON.stringify({ schema: 'delorun.production-keys/1', roots: [], keyids })}\n`)
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'registry'])
  return repo
}

describe('sign-timestamp', CHILD_PROCESS_TIMEOUT, () => {
  it('sign-timestamp-refuses-unlisted-production-key: refuses a timestamp key the release branch\'s registry does not list, and every key while it is empty', (test) => {
    const directory = scratch(test)
    const keys = throwawayKeys()
    const rootPath = join(directory, 'root.json')
    writeFileSync(rootPath, rootFile(keys, window()).bytes)
    const statePath = join(directory, 'state.json')
    expect(runEntry('sign-timestamp.ts', ['--init-state', '--root', rootPath, '--state', statePath]).status).toBe(0)
    const manifest = join(directory, 'delorun-0.1.0.manifest.json')
    writeFileSync(manifest, `${JSON.stringify(signEnvelope({ signed: toJsonValue(manifestContent('0.1.0', Buffer.from('archive'))), signatures: [] }, [keys.targets]), undefined, 2)}\n`)
    const env = { DELORUN_TIMESTAMP_KEY: keys.timestamp.export({ format: 'pem', type: 'pkcs8' }).toString() }
    const args = ['--state', statePath, '--root', rootPath, '--first', '--stable', manifest, '--beta', manifest, '--out', join(directory, 't1.json'), '--release-branch', 'main']
    const empty = runEntry('sign-timestamp.ts', args, env, registryRepository(join(directory, 'empty'), []))
    expect(empty.stderr).toContain('lists no production key')
    expect(empty.status).toBe(1)
    const other = runEntry('sign-timestamp.ts', args, env, registryRepository(join(directory, 'other'), ['0'.repeat(64)]))
    expect(other.stderr).toContain(`the timestamp key ${publicKeyEntry(keys.timestamp).keyid} is not a production key`)
    expect(existsSync(join(directory, 't1.json'))).toBe(false)
    expect(runEntry('sign-timestamp.ts', args, env, registryRepository(join(directory, 'listed'), [publicKeyEntry(keys.timestamp).keyid])).status).toBe(0)
  })

  it('starts from a state written once, continues only from the timestamp it holds, takes no --previous, and refuses a manifest another key signed', (test) => {
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
    const env = { DELORUN_TIMESTAMP_KEY: keys.timestamp.export({ format: 'pem', type: 'pkcs8' }).toString() }
    const repo = registryRepository(directory, [publicKeyEntry(keys.timestamp).keyid])
    const sign = (out: string, start: readonly string[], path = older): ReturnType<typeof runEntry> => runEntry('sign-timestamp.ts', ['--state', statePath, '--root', rootPath, ...start, '--stable', path, '--beta', path, '--out', join(directory, out), '--release-branch', 'main'], env, repo)
    expect(sign('none.json', []).stderr).toContain('the state records no timestamp yet; sign the first timestamp with --first')
    const first = sign('t1.json', ['--first'])
    expect(first.stderr).toBe('')
    expect(first.status).toBe(0)
    expect(readEnvelope('timestamp', readFileSync(join(directory, 't1.json'))).signed.version).toBe(1)
    expect(sign('first-again.json', ['--first']).stderr).toContain('the state records timestamp 1 as the last signed')
    const newer = manifest('0.2.0', keys.targets)
    expect(sign('t2.json', [], newer).status).toBe(0)
    const passed = sign('passed.json', ['--previous', join(directory, 't1.json')])
    expect(passed.stderr).toContain('--previous')
    expect(passed.status).toBe(1)
    const rollback = sign('rollback.json', [])
    expect(rollback.stderr).toContain('the stable channel would move back from 0.2.0 to 0.1.0')
    expect(rollback.status).toBe(1)
    expect(existsSync(join(directory, 'rollback.json'))).toBe(false)
    expect(sign('t3.json', [], newer).status).toBe(0)
    expect(readEnvelope('timestamp', readFileSync(join(directory, 't3.json'))).signed.version).toBe(3)
    const forged = sign('forged.json', [], manifest('0.3.0', keys.timestamp))
    expect(forged.stderr).toContain('0 valid signatures')
    expect(forged.status).toBe(1)
    expect(runEntry('sign-timestamp.ts', ['--state', statePath, '--root', rootPath, '--stable', newer, '--beta', newer, '--out', join(directory, 'x.json')], { DELORUN_TIMESTAMP_KEY: '' }).stderr).toContain('DELORUN_TIMESTAMP_KEY holds no key')
  })
})
