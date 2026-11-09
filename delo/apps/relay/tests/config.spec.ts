/**
 * The relay's configuration: the bindings and the ids they derive, the start refusals C6 lists,
 * the rebind statement's self-consistency, and the token key's mode and identity.
 */
import { chmodSync, existsSync, lstatSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRelayConfig, loadTokenKey, parseRelayConfig, RELAY_CONFIG_PATH } from '../src/config.ts'
import { isRelayError } from '../src/errors.ts'
import { generateEd25519, keyIdOf, rawPublicKey, toBase64Url } from '../src/keys.ts'
import { configText, tempDir, type TempDir } from './support.ts'

let temp: TempDir | undefined

afterEach(() => {
  temp?.remove()
  temp = undefined
})

function stateDir(): string {
  temp = tempDir('delo-relay-config-')
  return temp.dir
}

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error: unknown) {
    if (!isRelayError(error)) throw error
    return error.code
  }
  throw new Error('the configuration was accepted')
}

describe('bindings', () => {
  it('reads one name per binding and derives each home key id from the raw public key', () => {
    const homeKey = generateEd25519()
    const settings = parseRelayConfig(configText({ bindings: [{ name: 'Studio.Example.Test', homeKey }], stateDir: '/var/lib/delo-relay' }), { tokenKey: generateEd25519(), now: () => 1_000 })
    expect([...settings.bindings.keys()]).toEqual(['studio.example.test'])
    const binding = settings.bindings.get('studio.example.test')
    expect(binding?.homeKeyId).toBe(keyIdOf(Buffer.from(rawPublicKey(homeKey))))
    expect(binding?.homePublicKey.type).toBe('public')
    expect(settings.tunnelHost).toBe('relay.example.test')
    expect(settings.startedAt).toBe(1_000)
  })

  it('derives the relay id from the token public key, not from the token private key', () => {
    const tokenKey = generateEd25519()
    const settings = parseRelayConfig(configText({ bindings: [{ name: 'studio.example.test', homeKey: generateEd25519() }], stateDir: '/var/lib/delo-relay' }), { tokenKey, now: () => 0 })
    expect(settings.relayId).toBe(keyIdOf(Buffer.from(rawPublicKey(tokenKey))))
    expect(settings.relayId).not.toBe(toBase64Url(rawPublicKey(tokenKey)))
  })

  it('refuses a name that appears in two bindings', () => {
    const homeKey = generateEd25519()
    const text = configText({
      bindings: [
        { name: 'studio.example.test', homeKey },
        { name: 'studio.example.test', homeKey: generateEd25519() },
      ],
      stateDir: '/var/lib/delo-relay',
    })
    expect(refusal(() => parseRelayConfig(text, { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })

  it('refuses one home key bound to two names', () => {
    const homeKey = generateEd25519()
    const text = configText({
      bindings: [
        { name: 'one.example.test', homeKey },
        { name: 'two.example.test', homeKey },
      ],
      stateDir: '/var/lib/delo-relay',
    })
    expect(refusal(() => parseRelayConfig(text, { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })

  it('refuses a bound name that is also the tunnel host', () => {
    const text = configText({ bindings: [{ name: 'relay.example.test', homeKey: generateEd25519() }], tunnelHost: 'relay.example.test', stateDir: '/var/lib/delo-relay' })
    expect(refusal(() => parseRelayConfig(text, { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })

  it('refuses a name that is not a DNS host name', () => {
    const text = configText({ bindings: [{ name: 'not a name', homeKey: generateEd25519() }], stateDir: '/var/lib/delo-relay' })
    expect(refusal(() => parseRelayConfig(text, { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })

  it('refuses a tunnel host that is not a DNS host name', () => {
    const text = configText({ bindings: [{ name: 'studio.example.test', homeKey: generateEd25519() }], tunnelHost: '*', stateDir: '/var/lib/delo-relay' })
    expect(refusal(() => parseRelayConfig(text, { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })

  it('refuses a configuration that binds no name', () => {
    const text = configText({ bindings: [], stateDir: '/var/lib/delo-relay' })
    expect(refusal(() => parseRelayConfig(text, { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })

  it('refuses a home public key that is not 32 bytes', () => {
    const text = `tunnelHost: relay.example.test\ntunnelCertFile: /c.pem\ntunnelKeyFile: /k.pem\nbindings:\n  - name: studio.example.test\n    homePublicKey: AAAA\n`
    expect(refusal(() => parseRelayConfig(text, { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })
})

describe('rebind statements', () => {
  interface StatementOverrides {
    readonly name?: string
    readonly newHomePublicKey?: string
    readonly forceRebind?: boolean
  }

  function withStatement(overrides: StatementOverrides = {}, homeKey = generateEd25519()): string {
    const publicKey = toBase64Url(rawPublicKey(homeKey))
    const name = overrides.name ?? 'studio.example.test'
    const newHomePublicKey = overrides.newHomePublicKey ?? publicKey
    return [
      'tunnelHost: relay.example.test',
      'tunnelCertFile: /c.pem',
      'tunnelKeyFile: /k.pem',
      'bindings:',
      '  - name: studio.example.test',
      `    homePublicKey: ${publicKey}`,
      '    rebindStatement:',
      '      v: 1',
      `      name: ${name}`,
      '      previousHomeKeyId: cHJldmlvdXM',
      `      newHomePublicKey: ${newHomePublicKey}`,
      '      issuedAt: 1',
      '      signature: c2ln',
      ...overrides.forceRebind === true ? ['    forceRebind: true'] : [],
      '',
    ].join('\n')
  }

  it('accepts a statement that names its own binding and the key the binding holds', () => {
    const settings = parseRelayConfig(withStatement(), { tokenKey: generateEd25519(), now: () => 0 })
    expect(settings.bindings.has('studio.example.test')).toBe(true)
  })

  it('refuses a statement that names another binding', () => {
    expect(refusal(() => parseRelayConfig(withStatement({ name: 'other.example.test' }), { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })

  it('refuses a statement whose new key is not the binding\'s key', () => {
    expect(refusal(() => parseRelayConfig(withStatement({ newHomePublicKey: toBase64Url(rawPublicKey(generateEd25519())) }), { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })

  it('refuses forceRebind beside a statement, because C6 uses it only without the old key', () => {
    expect(refusal(() => parseRelayConfig(withStatement({ forceRebind: true }), { tokenKey: generateEd25519(), now: () => 0 }))).toBe('CONFIG_INVALID')
  })
})

describe('the token key', () => {
  it('is created at mode 0600 at the first start and read again by the next', () => {
    const dir = stateDir()
    const first = loadTokenKey(dir)
    const path = join(dir, 'token-key.pem')
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    const second = loadTokenKey(dir)
    expect(toBase64Url(rawPublicKey(second))).toBe(toBase64Url(rawPublicKey(first)))
  })

  it('refuses a key another user can read, and the relay keeps the key it had', () => {
    const dir = stateDir()
    const key = loadTokenKey(dir)
    chmodSync(join(dir, 'token-key.pem'), 0o644)
    expect(refusal(() => loadTokenKey(dir))).toBe('TOKEN_KEY_UNPROTECTED')
    expect(existsSync(join(dir, 'token-key.pem'))).toBe(true)
    expect(toBase64Url(rawPublicKey(loadTokenKeyAfterChmod(dir)))).toBe(toBase64Url(rawPublicKey(key)))
  })

  it('refuses a token key that is a symbolic link', () => {
    const dir = stateDir()
    const real = join(dir, 'real.pem')
    const key = generateEd25519()
    writeFileSync(real, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    symlinkSync(real, join(dir, 'token-key.pem'))
    expect(refusal(() => loadTokenKey(dir))).toBe('TOKEN_KEY_UNPROTECTED')
  })
})

describe('the configuration file', () => {
  it('refuses a file it cannot read', () => {
    expect(refusal(() => loadRelayConfig({ path: join(stateDir(), 'absent.yaml'), now: () => 0 }))).toBe('CONFIG_UNREADABLE')
  })

  it('reads the file named by its option and creates the token key its state directory names', () => {
    const dir = stateDir()
    const homeKey = generateEd25519()
    const path = join(dir, 'relay.yaml')
    writeFileSync(path, configText({ bindings: [{ name: 'studio.example.test', homeKey }], stateDir: join(dir, 'state') }))
    const settings = loadRelayConfig({ path, now: () => 7 })
    expect(settings.startedAt).toBe(7)
    expect(lstatSync(join(dir, 'state', 'token-key.pem')).mode & 0o777).toBe(0o600)
    expect(RELAY_CONFIG_PATH).toBe('/etc/delo-relay/relay.yaml')
  })

  it('refuses a document with a field the protocol does not define', () => {
    const dir = stateDir()
    const path = join(dir, 'relay.yaml')
    writeFileSync(path, `${configText({ bindings: [{ name: 'studio.example.test', homeKey: generateEd25519() }], stateDir: join(dir, 'state') })}port: 8443\n`)
    expect(refusal(() => loadRelayConfig({ path, now: () => 0 }))).toBe('CONFIG_INVALID')
  })
})

/** Put back a readable mode so the spec can show the refusal kept the key. */
function loadTokenKeyAfterChmod(dir: string): ReturnType<typeof loadTokenKey> {
  chmodSync(join(dir, 'token-key.pem'), 0o600)
  return loadTokenKey(dir)
}
