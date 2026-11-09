/**
 * The relay's log: C20's `relay` surface, the records the data plane writes, the token it
 * registers as a secret, and the refusal records that name a code and never a token. Removing
 * the registration in `RelayCore.acceptTunnel` lets a token reach a record, which the second
 * spec reads for.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRelayConfig } from '../src/config.ts'
import { generateEd25519 } from '../src/keys.ts'
import { openRelayLog, type RelayLogHandle } from '../src/log.ts'
import { RelayCore } from '../src/relay.ts'
import { peerAssertion } from '../src/peer.ts'
import { clientHello, configText, connectHome, FakeBrowser, FakeTimers, RecordingLog, tempDir, tokenRequestBody, type RelayFixture, type TempDir } from './support.ts'

const STUDIO = 'studio.example.test'
/** The instant the fixture's clock reports, so a token request's timestamp is in range. */
const NOW = Date.parse('2026-11-01T00:00:00.000Z')
let dir: TempDir | undefined
let handle: RelayLogHandle | undefined
let fixture: RelayFixture | undefined

afterEach(() => {
  fixture?.core.dispose()
  fixture = undefined
  handle?.close()
  handle = undefined
  dir?.remove()
  dir = undefined
})

/** One record from the surface's active file. */
interface StoredRecord {
  readonly surface: string
  readonly logger: string
  readonly level: string
  readonly msg: string
  readonly source: string
}

/** The relay's records from C20's active file. */
function records(): StoredRecord[] {
  const file = join(dir?.dir ?? '', 'relay.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as StoredRecord)
}

/** A relay whose log is C20's `relay` surface in a temporary directory. */
function loggedRelay(): { readonly fixture: RelayFixture; readonly handle: RelayLogHandle } {
  dir = tempDir('delo-relay-log-')
  const opened = openRelayLog({ dir: dir.dir, now: () => NOW })
  handle = opened
  const homeKey = generateEd25519()
  const settings = parseRelayConfig(configText({ bindings: [{ name: STUDIO, homeKey }], stateDir: join(dir.dir, 'state') }), { tokenKey: generateEd25519(), now: () => NOW })
  const core = new RelayCore({ settings, log: opened.log, now: () => NOW })
  fixture = { settings, core, log: new RecordingLog(), timers: new FakeTimers(), homes: new Map([[STUDIO, homeKey]]), tokenKey: settings.tokenKey, now: () => NOW }
  return { fixture, handle: opened }
}

describe('C20\'s relay surface', () => {
  it('writes the relay\'s records to the surface with C20\'s fields', () => {
    const { fixture: relay } = loggedRelay()
    const home = connectHome(relay, { name: STUDIO })
    expect(home.ready).toBe(true)
    relay.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), new FakeBrowser(peerAssertion({ address: '203.0.113.7', port: 40_200 })))
    const all = records()
    expect(all.length).toBeGreaterThan(0)
    expect(all.every(record => record.surface === 'relay')).toBe(true)
    expect(all.every(record => record.logger === 'delo-relay')).toBe(true)
    expect(all.every(record => record.source === 'delo')).toBe(true)
    expect(all.map(record => record.msg).some(msg => msg.startsWith('tunnel live'))).toBe(true)
    expect(all.map(record => record.msg).some(msg => msg.startsWith('browser connection routed'))).toBe(true)
  })

  it('registers each presented tunnel token with the redactor, so no record can carry it', () => {
    const { fixture: relay, handle: opened } = loggedRelay()
    const homeKey = relay.homes.get(STUDIO)
    if (homeKey === undefined) throw new Error('the fixture binds no home key')
    const token = relay.core.tokenRequest(tokenRequestBody(homeKey, STUDIO, relay.now())).token
    expect(connectHome(relay, { name: STUDIO, token }).ready).toBe(true)
    expect(opened.redactor.text(token)).toBe('[redacted:relay-key]')
    expect(records().every(record => !JSON.stringify(record).includes(token))).toBe(true)
  })

  it('records a refused upgrade with its code and no token', () => {
    const { fixture: relay } = loggedRelay()
    const refused = connectHome(relay, { name: STUDIO, authorization: 'Delo-Tunnel not.a.token' })
    expect(refused.accepted).toBe(false)
    const refusals = records().filter(record => record.msg.includes('tunnel upgrade refused'))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.level).toBe('warn')
    expect(refusals[0]?.msg).toContain('TUNNEL_TOKEN_INVALID')
    expect(JSON.stringify(records())).not.toContain('not.a.token')
  })

  it('names a second tunnel\'s refusal in the log', () => {
    const { fixture: relay } = loggedRelay()
    connectHome(relay, { name: STUDIO })
    connectHome(relay, { name: STUDIO })
    expect(records().map(record => record.msg).some(msg => msg.startsWith('a second tunnel for a live name was refused'))).toBe(true)
  })
})
