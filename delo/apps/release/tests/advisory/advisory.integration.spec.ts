/**
 * The dependency advisory check (contract C2's `c02-advisory-fails-release`, `c02-advisory-acceptance-passes-and-shows`,
 * `c02-advisory-lapsed-acceptance-fails` and `c02-advisory-feed-unreachable-fails`) against a local stand-in of npm's
 * bulk advisory API, with a fixture lockfile carrying a planted advisory id, a bundled dependency the lockfile does not
 * list, the pinned pnpm, approvers checked against CODEOWNERS, and notes built only from the signed report.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { checkAdvisories, codeOwners, localPackageNames, lockedPackages, readAcceptances } from '../../src/advisory/check.ts'
import { releaseAdvisoryCheck } from '../../src/advisory/release.ts'
import { sha256Hex } from '@delo/release-formats/brands'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { RECIPE_DIR } from '../../src/closure/config.ts'
import { scratch, writeTree } from '../support.ts'
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
      if (request.url === '/bad-range') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ 'example-parser': [{ id: 1, url: `https://github.com/advisories/${PLANTED}`, title: 'Parser reads past its buffer', severity: 'high', vulnerable_versions: '>= one point two' }] }))
        return
      }
      if (request.url === '/unavailable') {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      if (request.url === '/bundled') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ 'bundled-parser': [{ id: 2, url: 'https://github.com/advisories/GHSA-5555-6666-7777', title: 'Bundled parser loops', severity: 'high', vulnerable_versions: '<2.0.0' }] }))
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
    added: 2026-11-06
`

function request(version: string, acceptances: string, url = feed) {
  return { version: version as SemanticVersion, packages: lockedPackages(LOCKFILE), acceptances: readAcceptances(acceptances), owners: ['example-maintainer'], feed: url }
}

describe('advisory check', () => {
  it('asks the feed about every locked registry version and leaves local packages out', async () => {
    expect(lockedPackages(LOCKFILE)).toEqual([{ name: 'example-parser', version: '1.2.3' }, { name: 'safe-package', version: '2.0.0' }])
    expect([...localPackageNames(LOCKFILE)]).toEqual(['@deepseek-ai/cordis'])
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

  it('fails when the feed answers a status other than 200, or a vulnerable range the check cannot read', async () => {
    const unavailable = await checkAdvisories(request('0.2.0', ACCEPTED, `${feed}/unavailable`))
    expect(unavailable.result).toBe('fail')
    expect(unavailable.problems[0]).toMatch(/answered HTTP 503/u)
    const badRange = await checkAdvisories(request('0.2.0', ACCEPTED, `${feed}/bad-range`))
    expect(badRange.result).toBe('fail')
    expect(badRange.problems[0]).toMatch(/malformed response.*vulnerable_versions/u)
  })

  it('does not apply an acceptance of the same advisory for another package', async () => {
    const report = await checkAdvisories(request('0.2.0', ACCEPTED.replace('package: example-parser', 'package: other-parser')))
    expect(report.result).toBe('fail')
    expect(report.problems).toEqual([`${PLANTED} (moderate) affects example-parser@1.2.3: no acceptance covers it`])
  })

  it('refuses an acceptance whose approver is not a CODEOWNERS owner of the acceptances file', async () => {
    const report = await checkAdvisories({ ...request('0.2.0', ACCEPTED), owners: ['someone-else'] })
    expect(report.result).toBe('fail')
    expect(report.problems[0]).toContain('its acceptance\'s approver example-maintainer is not a CODEOWNERS owner of delo/release/advisory-acceptances.yaml')
    expect(codeOwners('* @root-owner\n# release\ndelo/release/ @release-owner @org/team\n', 'delo/release/advisory-acceptances.yaml')).toEqual(['release-owner'])
    expect(codeOwners('delo/release/ @release-owner\n* @root-owner\n', 'delo/release/advisory-acceptances.yaml')).toEqual(['root-owner'])
    expect(codeOwners('/docs/ @docs-owner\n', 'delo/release/advisory-acceptances.yaml')).toEqual([])
  })

  it('refuses an acceptance without the date its entry was added', () => {
    expect(() => readAcceptances(ACCEPTED.replace('    added: 2026-11-06\n', ''))).toThrow(/added/u)
    expect(() => readAcceptances(ACCEPTED.replace('added: 2026-11-06', 'added: last week'))).toThrow(/added/u)
  })

  it('checks a bundled dependency the lockfile does not list and the pinned pnpm, and leaves workspace packages out', async (test) => {
    const repo = scratchRepo(test)
    const toolchain = readFileSync(join(RECIPE_DIR, 'toolchain.json'), 'utf8')
    const commit = repo.commit({
      'delo/release/advisory-acceptances.yaml': 'acceptances: []\n',
      '.github/CODEOWNERS': '* @example-maintainer\n',
      'delo/apps/release/toolchain.json': toolchain,
      'delo/apps/release/rebuild-exceptions.json': readFileSync(join(RECIPE_DIR, 'rebuild-exceptions.json'), 'utf8'),
      'delo/apps/release/closure.json': readFileSync(join(RECIPE_DIR, 'closure.json'), 'utf8'),
      'delo/apps/release/images.json': readFileSync(join(RECIPE_DIR, 'images.json'), 'utf8'),
    })
    const release = scratch(test)
    const stage = join(release, '..', `${release.split('/').at(-1)!}-stage`)
    writeTree(stage, {
      'app/pnpm-lock.yaml': LOCKFILE,
      'app/node_modules/example-parser/package.json': '{"name":"example-parser","version":"1.2.3"}',
      'app/node_modules/example-parser/node_modules/bundled-parser/package.json': '{"name":"bundled-parser","version":"1.0.0"}',
      'app/node_modules/@deepseek-ai/cordis/package.json': '{"name":"@deepseek-ai/cordis","version":"4.0.0"}',
    })
    await archiveClosure({ stage, outDir: release, version: '0.2.0', platform: 'linux-x64', epoch: 1_793_981_656, pins: undefined })
    const report = await releaseAdvisoryCheck(repo.root, commit, release, '0.2.0' as SemanticVersion, `${feed}/bundled`)
    const pnpm = (JSON.parse(toolchain) as { pnpm: { version: string } }).pnpm.version
    expect(received).toEqual({ 'bundled-parser': ['1.0.0'], 'example-parser': ['1.2.3'], 'pnpm': [pnpm], 'safe-package': ['2.0.0'] })
    expect(report.result).toBe('fail')
    expect(report.problems).toEqual(['GHSA-5555-6666-7777 (high) affects bundled-parser@1.0.0: no acceptance covers it'])
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

  it('shows each accepted advisory in the assembled release notes, only from the report the signed manifest names', async () => {
    const report = await checkAdvisories(request('0.2.0', ACCEPTED))
    const bytes = Buffer.from(`${JSON.stringify(report, undefined, 2)}\n`)
    const signed = { report: { name: 'delorun-0.2.0.advisories.json', length: bytes.byteLength, sha256: sha256Hex(createHash('sha256').update(bytes).digest('hex')) }, accepted: [PLANTED] }
    const notes = renderAssembly('0.2.0', 'dsh-v0.2.2-rc.1', [], acceptedAdvisories(bytes, '0.2.0', signed)).notes
    expect(notes).toContain('## Accepted advisories')
    expect(notes).toContain(`- ${PLANTED} in \`example-parser\` \`>=1.2.0 <1.2.5\`: The vulnerable parser is not reachable from the closure's code paths. Approved by example-maintainer on 2026-11-06; the acceptance lapses after 0.3.0.`)
    const edited = Buffer.from(bytes.toString('utf8').replace('not reachable', 'never reachable'))
    expect(() => acceptedAdvisories(edited, '0.2.0', signed)).toThrow('the advisory report is not delorun-0.2.0.advisories.json, the report the signed manifest names')
    expect(() => acceptedAdvisories(bytes, '0.2.0', { ...signed, accepted: [] })).toThrow('the advisory report accepts other advisories than the signed manifest lists')
    const failed = Buffer.from(JSON.stringify({ ...report, result: 'fail' }))
    expect(() => acceptedAdvisories(failed, '0.2.0', { ...signed, report: { ...signed.report, length: failed.byteLength, sha256: sha256Hex(createHash('sha256').update(failed).digest('hex')) } })).toThrow(/did not pass/u)
    expect(() => acceptedAdvisories(bytes, '0.2.1', signed)).toThrow(/not the report of release 0.2.1/u)
  })
})
