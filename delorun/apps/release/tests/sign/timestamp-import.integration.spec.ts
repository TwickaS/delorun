/**
 * Adopting the timestamp a channel serves into the signer's state (G3): the Worker's daily re-signing moves the
 * channel past the state, and the import brings the state level, or refuses what a client would not accept.
 * Throwaway keys generated in the test.
 */
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TimestampMetadata, UtcTimestamp } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { trustRootChain, type TrustedRoot } from '@delorun/release-formats/sign/verify'
import { importTimestamp, initialState, nextTimestamp, readTimestampState, resignedTimestamp, stateAfter, type ManifestFile } from '../../src/sign/timestamp.ts'
import { runEntry, scratch } from '../support.ts'
import { manifestContent, rootFile, throwawayKeys, type Keys } from './fixture.ts'

const NOW = Date.parse('2026-11-10T12:00:00Z') / 1000
const DAY = 86_400

function signedFile(content: object, key = throwawayKeys().timestamp): Buffer {
  return Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(content), signatures: [] }, [key]), undefined, 2)}\n`)
}

function manifest(keys: Keys, version: string): ManifestFile {
  return { name: `delorun-${version}.manifest.json`, bytes: signedFile({ ...manifestContent(version, Buffer.from(`archive ${version}`)), channel: 'stable' }, keys.targets) }
}

function utc(seconds: number): UtcTimestamp {
  return brandString<UtcTimestamp>(`${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`)
}

/** A signer that signed timestamp 1, and a channel the Worker re-signed twice since (timestamp 3). */
function setup(base = NOW) {
  const keys = throwawayKeys()
  const rootBytes = rootFile(keys).bytes
  const root: TrustedRoot = trustRootChain([rootBytes], base).at(-1)!
  const first = manifest(keys, '0.1.0')
  const one = nextTimestamp({ state: initialState(root), roots: [root], first: true, manifests: { stable: first, beta: first }, replaced: [], now: base })
  const oneBytes = signedFile(one, keys.timestamp)
  const state = stateAfter(root, oneBytes, one.version)
  const resign = (previous: TimestampMetadata, at: number): { metadata: TimestampMetadata, bytes: Buffer } => {
    const metadata = resignedTimestamp(previous, at)
    return { metadata, bytes: signedFile(metadata, keys.timestamp) }
  }
  const two = resign(one, base + DAY)
  const three = resign(two.metadata, base + 2 * DAY)
  return { keys, rootBytes, root, state, one, oneBytes, two, three, now: base + 2 * DAY + 60, first }
}

describe('importTimestamp', () => {
  it('adopts a served timestamp that the daily re-signing moved on, so the next signing continues from it', () => {
    const s = setup()
    const adopted = importTimestamp({ state: s.state, roots: [s.root], bytes: s.three.bytes, now: s.now })!
    expect(adopted.timestamp).toMatchObject({ version: 3 })
    expect(Buffer.from(adopted.timestamp!.file, 'base64')).toEqual(s.three.bytes)
    const next = nextTimestamp({ state: adopted, roots: [s.root], first: false, manifests: { stable: s.first, beta: s.first }, replaced: [], now: s.now })
    expect(next.version).toBe(4)
  })

  it('without the import the next signing collides with the Worker: version 2 against a served 3', () => {
    const s = setup()
    expect(nextTimestamp({ state: s.state, roots: [s.root], first: false, manifests: { stable: s.first, beta: s.first }, replaced: [], now: s.now }).version).toBe(2)
  })

  it('changes nothing when the state already holds the served file', () => {
    const s = setup()
    expect(importTimestamp({ state: s.state, roots: [s.root], bytes: s.oneBytes, now: NOW + 60 })).toBeUndefined()
  })

  it('refuses a signature by another key', () => {
    const s = setup()
    const forged = signedFile(s.three.metadata, generateKeyPairSync('ed25519').privateKey)
    expect(() => importTimestamp({ state: s.state, roots: [s.root], bytes: forged, now: s.now })).toThrow(/signature/iu)
  })

  it('refuses a file whose signature was damaged', () => {
    const s = setup()
    const text = s.three.bytes.toString().replace(/"version": 3/u, '"version": 9')
    expect(() => importTimestamp({ state: s.state, roots: [s.root], bytes: Buffer.from(text), now: s.now })).toThrow(/signature/iu)
  })

  it('refuses an older timestamp than the state holds', () => {
    const s = setup()
    const ahead = stateAfter(s.root, s.three.bytes, 3)
    expect(() => importTimestamp({ state: ahead, roots: [s.root], bytes: s.two.bytes, now: s.now })).toThrow('the channel serves timestamp 2, below the state\'s 3; nothing is imported')
  })

  it('refuses a different file of the same version', () => {
    const s = setup()
    const ahead = stateAfter(s.root, s.three.bytes, 3)
    const fork = signedFile({ ...s.three.metadata, issued: utc(NOW + 2 * DAY - 7200), expires: utc(NOW + 2 * DAY - 7200 + 259_200) }, s.keys.timestamp)
    expect(() => importTimestamp({ state: ahead, roots: [s.root], bytes: fork, now: s.now })).toThrow(/differs from the state's file of the same version/u)
  })

  it('refuses an expired timestamp', () => {
    const s = setup()
    expect(() => importTimestamp({ state: s.state, roots: [s.root], bytes: s.three.bytes, now: NOW + 2 * DAY + 4 * DAY })).toThrow(/expired/u)
  })

  it('refuses a timestamp that moves a channel back', () => {
    const s = setup()
    const newer = manifest(s.keys, '0.2.0')
    const two = nextTimestamp({ state: s.state, roots: [s.root], first: false, manifests: { stable: newer, beta: newer }, replaced: [], now: NOW + DAY })
    const ahead = stateAfter(s.root, signedFile(two, s.keys.timestamp), 2)
    const back = signedFile({ ...s.three.metadata, version: 3 }, s.keys.timestamp)
    expect(() => importTimestamp({ state: ahead, roots: [s.root], bytes: back, now: s.now })).toThrow(/below the state's 0\.2\.0/u)
  })

  it('refuses a timestamp for a root the state does not trust', () => {
    const s = setup()
    const stranger = trustRootChain([rootFile(throwawayKeys()).bytes], NOW).at(-1)!
    expect(() => importTimestamp({ state: s.state, roots: [stranger], bytes: s.three.bytes, now: s.now })).toThrow(/the state trusts root 1/u)
  })
})

describe('sign-timestamp --import-from', () => {
  it('updates the state from a downloaded file, and a lower version then leaves the state as it was', (test) => {
    const directory = scratch(test)
    // The command reads the real clock, so the fixture's timestamps are dated from it.
    const s = setup(Math.floor(Date.now() / 1000) - 2 * DAY)
    const paths = { root: join(directory, '1.root.json'), state: join(directory, 'state.json'), served: join(directory, 'timestamp.json'), older: join(directory, 'older.json') }
    writeFileSync(paths.root, s.rootBytes)
    writeFileSync(paths.state, `${JSON.stringify(s.state, undefined, 2)}\n`)
    writeFileSync(paths.served, s.three.bytes)
    writeFileSync(paths.older, s.two.bytes)
    const imported = runEntry('sign-timestamp.ts', ['--import-from', paths.served, '--root', paths.root, '--state', paths.state])
    expect(imported.stderr).toBe('')
    expect(imported.stdout).toContain('the next signing is version 4')
    expect(readTimestampState(readFileSync(paths.state)).timestamp?.version).toBe(3)
    const lower = runEntry('sign-timestamp.ts', ['--import-from', paths.older, '--root', paths.root, '--state', paths.state])
    expect(lower.status).toBe(1)
    expect(lower.stderr).toContain('below the state\'s 3')
    expect(readTimestampState(readFileSync(paths.state)).timestamp?.version).toBe(3)
    const missing = runEntry('sign-timestamp.ts', ['--import-from', join(directory, 'missing.json'), '--root', paths.root, '--state', paths.state])
    expect(missing.status).toBe(1)
  }, 60_000)
})
