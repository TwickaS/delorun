import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALLOWLIST_PATH, fileErrors, lineFindings, type AllowlistFile } from '../../src/checks/gates/infrastructure.ts'
import { gatePath, ledgerRepo, runTsx } from './support.ts'

// Identifiers are assembled at run time, so this file holds none for the gate to find.
const ip = (...octets: number[]): string => octets.join('.')
const PRIVATE = ip(10, 1, 2, 3)
const PUBLIC = ip(8, 8, 8, 8)
const TAILNET = ['host', 'tail1234', 'ts', 'net'].join('.')
const EXAMPLE_TAILNET = ['host', 'example', 'ts', 'net'].join('.')
const ACCOUNT = ['111122', '223333'].join('')
const DOCUMENTATION_ACCOUNT = ['123456', '789012'].join('')
const NO_ALLOWLIST: AllowlistFile = { entries: [] }

describe('identifiers of a deployment', () => {
  it('refuses an IPv4 address outside the documentation ranges', () => {
    expect(lineFindings(`const host = "${PRIVATE}"`, 1)).toEqual([{ kind: 'IPv4 address', value: PRIVATE, line: 1 }])
    expect(lineFindings(`dial ${PUBLIC}`, 2)).toEqual([{ kind: 'IPv4 address', value: PUBLIC, line: 2 }])
  })

  it('accepts loopback, the unspecified and broadcast addresses, and RFC 5737 documentation addresses', () => {
    for (const address of [ip(127, 0, 0, 1), ip(127, 8, 9, 10), ip(0, 0, 0, 0), ip(255, 255, 255, 255), ip(192, 0, 2, 20), ip(198, 51, 100, 7), ip(203, 0, 113, 9)]) {
      expect(lineFindings(`address ${address}`, 1)).toEqual([])
    }
  })

  it('exempts the cloud metadata addresses as public constants, and still refuses another link-local IPv4 address', () => {
    expect(lineFindings('metadata 169.254.169.254', 1)).toEqual([])
    expect(lineFindings('metadata fd00:ec2::254', 1)).toEqual([])
    const linkLocal = ip(169, 254, 1, 1)
    expect(lineFindings(`link-local ${linkLocal}`, 1)).toEqual([{ kind: 'IPv4 address', value: linkLocal, line: 1 }])
  })

  it('refuses an IPv6 address in the globally routable or unique-local ranges, and passes loopback, link-local and documentation addresses', () => {
    const unique = ['fd00', 'ec2', '', '255'].join(':')
    const routable = ['2a0b', '1', '', '1'].join(':')
    expect(lineFindings(`unique ${unique}`, 1)).toEqual([{ kind: 'IPv6 address', value: unique, line: 1 }])
    expect(lineFindings(`routable ${routable}`, 1)).toEqual([{ kind: 'IPv6 address', value: routable, line: 1 }])
    expect(lineFindings('loopback ::1, unspecified ::, link-local fe80::1, documentation 2001:db8::1', 1)).toEqual([])
  })

  it('passes the base addresses of the reserved blocks, and still refuses a host address inside a reserved block', () => {
    expect(lineFindings('blocks 10.0.0.0, 100.64.0.0, 169.254.0.0, 172.16.0.0, 192.168.0.0, 224.0.0.0', 1)).toEqual([])
    expect(lineFindings('unique block fc00::', 1)).toEqual([])
    const host = ip(192, 168, 7, 9)
    expect(lineFindings(`host ${host}`, 1)).toEqual([{ kind: 'IPv4 address', value: host, line: 1 }])
    const uniqueHost = ['fc00', '1'].join('::')
    expect(lineFindings(`unique host ${uniqueHost}`, 1)).toEqual([{ kind: 'IPv6 address', value: uniqueHost, line: 1 }])
  })

  it('does not read a version number as an address', () => {
    expect(lineFindings(`release ${['1', '2', '3', '4', '5'].join('.')} and ${ip(10, 1, 5)}`, 1)).toEqual([])
    expect(lineFindings('build 1.2.3.4.5', 1)).toEqual([])
    expect(lineFindings('kernel 5.15.153.1-microsoft-standard-WSL2', 1)).toEqual([])
  })

  it('still refuses a real address in prose, even beside punctuation', () => {
    expect(lineFindings(`the relay runs at ${ip(8, 8, 4, 4)}; retry`, 1)).toEqual([{ kind: 'IPv4 address', value: ip(8, 8, 4, 4), line: 1 }])
    expect(lineFindings(`(${ip(8, 8, 4, 4)}).`, 2)).toEqual([{ kind: 'IPv4 address', value: ip(8, 8, 4, 4), line: 2 }])
  })

  it('refuses a tailnet name other than the example tailnet', () => {
    expect(lineFindings(`ssh ${TAILNET}`, 1)).toEqual([{ kind: 'tailnet name', value: TAILNET, line: 1 }])
    expect(lineFindings(`open ${EXAMPLE_TAILNET}`, 1)).toEqual([])
  })

  it('refuses a cloud account ID, and accepts the documentation account of AWS\'s own examples', () => {
    expect(lineFindings(`arn:aws:iam::${ACCOUNT}:role/deploy`, 1)).toEqual([{ kind: 'cloud account ID', value: ACCOUNT, line: 1 }])
    expect(lineFindings(`${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/app`, 1)).toEqual([{ kind: 'cloud account ID', value: ACCOUNT, line: 1 }])
    expect(lineFindings(`arn:aws:iam::${DOCUMENTATION_ACCOUNT}:role/example`, 1)).toEqual([])
  })

  it('passes a line that upstream holds word for word, and a value the allowlist names for that path', () => {
    const text = `const host = "${PRIVATE}"\nconst other = "${PRIVATE}"\n`
    expect(fileErrors('fixture.ts', text, NO_ALLOWLIST, new Set([`const host = "${PRIVATE}"`]))).toEqual([
      expect.stringContaining(`fixture.ts:2: IPv4 address ${PRIVATE}`),
    ])
    const allowed: AllowlistFile = { entries: [{ path: 'fixture.ts', value: PRIVATE, reason: 'a test fixture' }] }
    expect(fileErrors('fixture.ts', text, allowed, undefined)).toEqual([])
    expect(fileErrors('other.ts', text, allowed, undefined)).toHaveLength(2)
  })

  it('skips a binary file', () => {
    expect(fileErrors('image.bin', `\0\u0001 ${PRIVATE}`, NO_ALLOWLIST)).toEqual([])
  })
})

describe('gates:infrastructure from the command line', () => {
  it('refuses a staged path that holds a private address, and passes one that uses a documentation address', (test) => {
    const { repo } = ledgerRepo(test)
    mkdirSync(join(repo.root, 'delorun/apps/tools/src/checks/gates'), { recursive: true })
    writeFileSync(join(repo.root, ALLOWLIST_PATH), `${JSON.stringify(NO_ALLOWLIST, null, 2)}\n`)
    repo.write({ 'deploy.ts': `const relay = "${PRIVATE}"\n` })
    const refused = runTsx(repo.root, gatePath('infrastructure'), ['deploy.ts'])
    expect(refused.status).toBe(1)
    expect(refused.output).toContain(`deploy.ts:1: IPv4 address ${PRIVATE}`)

    repo.write({ 'deploy.ts': `const relay = "${ip(192, 0, 2, 10)}"\n` })
    expect(runTsx(repo.root, gatePath('infrastructure'), ['deploy.ts']).status).toBe(0)
  }, 60_000)
})
