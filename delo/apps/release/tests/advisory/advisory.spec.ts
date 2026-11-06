/**
 * The dependency advisory check (contract C2's `c02-advisory-fails-release`, `c02-advisory-acceptance-passes-and-shows`,
 * `c02-advisory-lapsed-acceptance-fails` and `c02-advisory-feed-unreachable-fails`) against a local stand-in of npm's
 * bulk advisory API, with a fixture lockfile carrying a planted advisory id.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { acceptanceDate, checkAdvisories, lockedPackages, readAcceptances } from '../../src/advisory/check.ts'
import { acceptedAdvisories, renderAssembly } from '../../src/changelog/assemble.ts'
import { scratchRepo } from '../changelog/support.ts'

const PLANTED = 'GHSA-2222-3333-4444'

const LOCKFILE = `lockfileVersion: '9.0'

packages:

  example-parser@1.2.3:
    resolution: {integrity: sha512-${'A'.repeat(86)}==}

  safe-package@2.0.0:
    resolution: {integrity: sha512-${'B'.repeat(86)}==}

  '@deepseek-ai/cordis@file:///var/tmp/delo-release-build/source/vendor/cordis':
    resolution: {directory: /var/tmp/delo-release-build/source/vendor/cordis, type: directory}
`

let server: Server
let feed: string
let received: unknown

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      received = JSON.parse(body)
      if (request.url === '/malformed') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"example-parser": [{"id": 1}]}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ 'example-parser': [{ id: 1, url: `https://github.com/advisories/${PLANTED}`, title: 'Parser reads past its buffer', severity: 'moderate', vulnerable_versions: '>=1.2.0 <1.2.5' }] }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  feed = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

const ACCEPTED = `acceptances:
  - advisory: ${PLANTED}
    package: example-parser
    range: '>=1.2.0 <1.2.5'
    reason: The vulnerable parser is not reachable from the closure's code paths.
    approver: example-maintainer
    lapsesAfter: 0.3.0
`

function request(version: string, acceptances: string, url = feed) {
  return { version: version as SemanticVersion, lockfiles: [LOCKFILE], acceptances: readAcceptances(acceptances), feed: url, added: () => '2026-11-06' }
}

describe('advisory check', () => {
  it('asks the feed about every locked registry version and leaves local packages out', async () => {
    expect(lockedPackages(LOCKFILE)).toEqual([{ name: 'example-parser', version: '1.2.3' }, { name: 'safe-package', version: '2.0.0' }])
    await checkAdvisories(request('0.2.0', 'acceptances: []\n'))
    expect(received).toEqual({ 'example-parser': ['1.2.3'], 'safe-package': ['2.0.0'] })
  })

  it('fails a lockfile carrying a planted advisory without an acceptance', async () => {
    const report = await checkAdvisories(request('0.2.0', 'acceptances: []\n'))
    expect(report.result).toBe('fail')
    expect(report.problems).toEqual([`${PLANTED} (moderate) affects example-parser@1.2.3: no acceptance covers it`])
  })

  it('passes the same lockfile with a matching acceptance, recording the acceptance and its date', async () => {
    const report = await checkAdvisories(request('0.2.0', ACCEPTED))
    expect(report.result).toBe('pass')
    expect(report.findings[0]?.accepted).toMatchObject({ advisory: PLANTED, package: 'example-parser', range: '>=1.2.0 <1.2.5', approver: 'example-maintainer', lapsesAfter: '0.3.0', added: '2026-11-06' })
  })

  it('fails a release above the acceptance\'s lapse release', async () => {
    const report = await checkAdvisories(request('0.3.1', ACCEPTED))
    expect(report.result).toBe('fail')
    expect(report.problems[0]).toContain('its acceptance lapsed after 0.3.0')
  })

  it('fails when the acceptance\'s range does not cover the locked version', async () => {
    const report = await checkAdvisories(request('0.2.0', ACCEPTED.replace("'>=1.2.0 <1.2.5'", "'>=1.2.4 <1.2.5'")))
    expect(report.result).toBe('fail')
  })

  it('fails when the feed refuses connections, or answers malformed', async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise(resolve => closed.close(resolve))
    const unreachable = await checkAdvisories(request('0.2.0', ACCEPTED, `http://127.0.0.1:${String(port)}`))
    expect(unreachable.result).toBe('fail')
    expect(unreachable.problems[0]).toMatch(/cannot be reached/u)
    const malformed = await checkAdvisories(request('0.2.0', ACCEPTED, `${feed}/malformed`))
    expect(malformed.result).toBe('fail')
    expect(malformed.problems[0]).toMatch(/malformed response/u)
  })

  it('refuses an acceptances file with an unknown field or a duplicate key', () => {
    expect(() => readAcceptances(`${ACCEPTED}    expires: never\n`)).toThrow(/expires/u)
    expect(() => readAcceptances(ACCEPTED.replace('    approver: example-maintainer\n', '    approver: example-maintainer\n    approver: someone-else\n'))).toThrow()
  })

  it('shows each accepted advisory in the assembled release notes with its package, range, reason, approver, lapse release and date', async () => {
    const report = await checkAdvisories(request('0.2.0', ACCEPTED))
    const notes = renderAssembly('0.2.0', 'dsh-v0.2.2-rc.1', [], acceptedAdvisories(JSON.stringify(report), '0.2.0')).notes
    expect(notes).toContain('## Accepted advisories')
    expect(notes).toContain(`- ${PLANTED} in \`example-parser\` \`>=1.2.0 <1.2.5\`: The vulnerable parser is not reachable from the closure's code paths. Approved by example-maintainer on 2026-11-06; the acceptance lapses after 0.3.0.`)
    expect(() => acceptedAdvisories(JSON.stringify({ ...report, result: 'fail' }), '0.2.0')).toThrow(/did not pass/u)
    expect(() => acceptedAdvisories(JSON.stringify(report), '0.2.1')).toThrow(/not the report of release 0.2.1/u)
  })

  it('dates an acceptance by the commit that added its entry', (test) => {
    const repo = scratchRepo(test)
    const before = repo.commit({ 'delo/release/advisory-acceptances.yaml': 'acceptances: []\n' })
    expect(acceptanceDate(repo.root, PLANTED, before)).toBe('uncommitted')
    const after = repo.commit({ 'delo/release/advisory-acceptances.yaml': ACCEPTED })
    expect(acceptanceDate(repo.root, PLANTED, after)).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    expect(acceptanceDate(repo.root, PLANTED, before)).toBe('uncommitted')
  })
})
