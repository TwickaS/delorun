/**
 * The patch rule over small git repositories each spec builds: a release that is a patch of an existing release keeps
 * its upstream base, its data formats and its plugin-facing interface, pre-release tags are no existing release, a new
 * minor is no patch, and the draft's `dsh` must be the base the release commit names. Before comparing, the earlier
 * releases' tags must lie on the release commit's history and agree with the committed changelog, and a patch version
 * with none needs the first-of-line statement. Each refusal names the earlier release, what differs and the remedy.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DATA_PATH } from '../../src/changelog/paths.ts'
import { DELO_RECORDS_PATH, earlierReleases, patchRuleProblem, releaseLineProblem, UPSTREAM_VERSION_PATH, upstreamVersionAt } from '../../src/sign/patch-rule.ts'
import { PLUGIN_INTERFACE_PATH } from '../../src/sign/plugin-interface.ts'
import { scratch } from '../support.ts'

const SERVICE_SOURCE = 'delo/packages/fixture/src/client/index.ts'
const FIELD_SOURCE = 'packages/boot/fixture/src/compatibility.ts'
const PERSISTENCE = 'docs/persistence-schema.json'

const SERVICE = { kind: 'service', name: 'deloFixture', side: 'browser', source: SERVICE_SOURCE }
const FIELD = { kind: 'manifest-field', name: 'engines.delo', source: FIELD_SOURCE }
const INTERNAL = { kind: 'service', name: 'deloInternal', side: 'host', source: 'delo/packages/fixture/src/internal.ts' }

/** The tree of a release's facts, by repository path; `null` removes the file. */
type Tree = Record<string, string | null>

/**
 * The text of a changelog data file listing assembled versions, with no bullets.
 * @param versions - the versions, oldest first.
 * @returns the file's text.
 */
function changelog(versions: readonly string[]): string {
  const entries = versions.map(version => ({ version, date: '2026-11-06', preview: version.includes('-'), areas: [], fromUpstream: { ref: 'dsh-v0.2.2-rc.1', items: [] }, previews: [] })).reverse()
  return `${JSON.stringify({ schema: 'delo.changelog/1', upstream: { ref: 'dsh-v0.2.2-rc.1', commit: '0'.repeat(40) }, compared: [], versions: entries }, undefined, 2)}\n`
}

/**
 * The facts of a release whose upstream base is `dsh`, with every file the rule reads.
 * @param dsh - the app-boot version.
 * @param versions - the versions the changelog lists; `0.1.2`, the release {@link patchOf} tags, by default.
 * @returns the tree.
 */
function facts(dsh: string, versions: readonly string[] = ['0.1.2']): Tree {
  return {
    [DATA_PATH]: changelog(versions),
    [UPSTREAM_VERSION_PATH]: `${JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: dsh })}\n`,
    [PERSISTENCE]: '{"schemaVersion":1}\n',
    [DELO_RECORDS_PATH]: '{\n  "update-record": 1\n}\n',
    [PLUGIN_INTERFACE_PATH]: inventory([SERVICE, FIELD], [INTERNAL]),
    [SERVICE_SOURCE]: 'declare module \'@deepseek-ai/cordis\' {\n  interface Context {\n    deloFixture: unknown\n  }\n}\n',
    [FIELD_SOURCE]: 'export function range(engines: Record<string, unknown>): unknown {\n  return engines.delo\n}\n',
  }
}

function inventory(covered: readonly object[], internal: readonly object[] = []): string {
  return `${JSON.stringify({ schema: 'delo.plugin-interface/1', covered, internal }, undefined, 2)}\n`
}

/** A repository the spec commits trees to; each commit may carry a tag. */
interface Repository {
  readonly path: string
  /** Write a tree over the work tree, commit it, tag it when a tag is given, and return the commit. */
  readonly commit: (tree: Tree, tag?: string) => string
  /** Run git in the repository and return its trimmed output. */
  readonly git: (...args: string[]) => string
}

function repository(test: Parameters<typeof scratch>[0]): Repository {
  const path = scratch(test, 'delo-patch-rule-')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: path, env, encoding: 'utf8', timeout: 30_000 }).trim()
  git('init', '-q', '-b', 'main')
  return {
    path,
    git,
    commit: (tree, tag) => {
      for (const [file, content] of Object.entries(tree)) {
        if (content === null) {
          rmSync(join(path, file), { force: true })
          continue
        }
        mkdirSync(dirname(join(path, file)), { recursive: true })
        writeFileSync(join(path, file), content)
      }
      git('add', '-A')
      git('commit', '-q', '--allow-empty', '-m', tag ?? 'change')
      if (tag !== undefined) git('tag', tag)
      return git('rev-parse', 'HEAD')
    },
  }
}

/**
 * A repository with release 0.1.2 tagged on base 0.2.2, and a release commit with `change` applied on top.
 * @returns the rule's problem for release 0.1.3 at that commit with draft `dsh`.
 */
function patchOf(test: Parameters<typeof scratch>[0], change: Tree, dsh = '0.2.2', version = '0.1.3'): string | undefined {
  const repo = repository(test)
  repo.commit(facts('0.2.2'), 'v0.1.2')
  const commit = repo.commit(change)
  return patchRuleProblem({ repository: repo.path, version, dsh, commit, firstOfLine: false })
}

describe('the patch rule', () => {
  it('patch-rule-refuses-base-move: a patch whose upstream base differs from the earlier release\'s is refused and told to be a minor', (test) => {
    expect(patchOf(test, facts('0.2.3'), '0.2.3')).toBe('release 0.1.3 is a patch of 0.1.2 and moves DSH from 0.2.2 to 0.2.3; a release that moves the upstream base is at least a minor: release it as 0.2.0')
    const repo = repository(test)
    repo.commit({ ...facts('0.2.2'), [UPSTREAM_VERSION_PATH]: null }, 'v0.1.2')
    const commit = repo.commit(facts('0.2.2'))
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.3', dsh: '0.2.2', commit, firstOfLine: false })).toBe(`release 0.1.3 is a patch of 0.1.2, and ${UPSTREAM_VERSION_PATH} at v0.1.2 names no version, so the rule cannot show the upstream base is unchanged; release it as 0.2.0`)
  })

  it('patch-rule-refuses-draft-base-mismatch: a draft whose dsh is not the base the release commit names is refused, patch or not', (test) => {
    const repo = repository(test)
    const commit = repo.commit(facts('0.2.2'))
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.0', dsh: '0.2.3', commit, firstOfLine: false })).toBe(`the draft's dsh 0.2.3 is not 0.2.2, the upstream version ${UPSTREAM_VERSION_PATH} names at the release commit ${commit}; draft the release with dsh 0.2.2`)
    const bare = repo.commit({ [UPSTREAM_VERSION_PATH]: null })
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.0', dsh: '0.2.2', commit: bare, firstOfLine: false })).toBe(`${UPSTREAM_VERSION_PATH} at the release commit ${bare} names no version, so the draft's dsh 0.2.2 cannot be shown to be the upstream base the release builds on`)
  })

  it('patch-rule-refuses-persistence-change: a patch that changes or lacks upstream\'s persistence-schema inventory is refused', (test) => {
    expect(patchOf(test, { [PERSISTENCE]: '{"schemaVersion":2}\n' })).toBe(`release 0.1.3 is a patch of 0.1.2 and changes ${PERSISTENCE}; a release that changes a data format is at least a minor: release it as 0.2.0`)
    expect(patchOf(test, { [PERSISTENCE]: null })).toMatch(new RegExp(`^release 0\\.1\\.3 is a patch of 0\\.1\\.2, and ${PERSISTENCE} is missing at [0-9a-f]{40}, so the rule cannot show the data formats are unchanged; release it as 0\\.2\\.0$`, 'u'))
    const repo = repository(test)
    repo.commit({ ...facts('0.2.2'), [PERSISTENCE]: null }, 'v0.1.2')
    const commit = repo.commit(facts('0.2.2'))
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.3', dsh: '0.2.2', commit, firstOfLine: false })).toContain(`${PERSISTENCE} is missing at v0.1.2`)
  })

  it('patch-rule-refuses-delo-record-change: a patch that changes a Delo record version is refused', (test) => {
    expect(patchOf(test, { [DELO_RECORDS_PATH]: '{\n  "update-record": 2\n}\n' })).toBe(`release 0.1.3 is a patch of 0.1.2 and changes ${DELO_RECORDS_PATH}; a release that changes a data format is at least a minor: release it as 0.2.0`)
  })

  it('patch-rule-refuses-interface-removal: a patch that drops a covered service, event or manifest field, or whose source no longer offers one, is refused', (test) => {
    expect(patchOf(test, { [PLUGIN_INTERFACE_PATH]: inventory([FIELD], [INTERNAL]) })).toBe(`release 0.1.3 is a patch of 0.1.2 and changes the plugin-facing interface: it removes service deloFixture (browser, in ${SERVICE_SOURCE}); a release that changes the plugin-facing interface, by adding to it too, is at least a minor: release it as 0.2.0`)
    const undeclared = patchOf(test, { [SERVICE_SOURCE]: 'declare module \'@deepseek-ai/cordis\' {\n  interface Context {\n    deloOther: unknown\n  }\n}\n' })
    expect(undeclared).toBe(`release 0.1.3 is a patch of 0.1.2, and the release commit no longer offers the service deloFixture (browser, in ${SERVICE_SOURCE}) that ${PLUGIN_INTERFACE_PATH} lists; a release that removes from the plugin-facing interface is at least a minor: restore it, or remove it from the inventory and release it as 0.2.0`)
    expect(patchOf(test, { [SERVICE_SOURCE]: null })).toContain('no longer offers the service deloFixture')
    expect(patchOf(test, { [FIELD_SOURCE]: 'export function range(engines: Record<string, unknown>): unknown {\n  return engines.dsh // engines.delo\n}\n' })).toContain(`no longer offers the manifest field engines.delo (read in ${FIELD_SOURCE})`)
    const repo = repository(test)
    const eventSource = 'delo/packages/fixture/src/events.d.ts'
    const event = { kind: 'event', name: 'delo/fixture', side: 'host', source: eventSource }
    repo.commit({ ...facts('0.2.2'), [eventSource]: 'declare module \'@deepseek-ai/cordis\' {\n  interface Events {\n    \'delo/fixture\'(): void\n  }\n}\n', [PLUGIN_INTERFACE_PATH]: inventory([SERVICE, FIELD, event]) }, 'v0.1.2')
    const dropped = repo.commit({ [PLUGIN_INTERFACE_PATH]: inventory([SERVICE, FIELD], [event]) })
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.3', dsh: '0.2.2', commit: dropped, firstOfLine: false })).toContain(`it removes event delo/fixture (host, in ${eventSource})`)
    const unoffered = repo.commit({ [PLUGIN_INTERFACE_PATH]: inventory([SERVICE, FIELD, event]), [eventSource]: 'export {}\n' })
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.3', dsh: '0.2.2', commit: unoffered, firstOfLine: false })).toContain(`no longer offers the event delo/fixture (host, in ${eventSource})`)
  })

  it('patch-rule-refuses-interface-addition: a patch that adds a covered entry is refused, because additions are a minor\'s', (test) => {
    const added = { kind: 'manifest-field', name: 'engines.studio', source: FIELD_SOURCE }
    expect(patchOf(test, { [PLUGIN_INTERFACE_PATH]: inventory([SERVICE, FIELD, added], [INTERNAL]) })).toBe(`release 0.1.3 is a patch of 0.1.2 and changes the plugin-facing interface: it adds manifest field engines.studio (read in ${FIELD_SOURCE}); a release that changes the plugin-facing interface, by adding to it too, is at least a minor: release it as 0.2.0`)
    const moved = { ...SERVICE, side: 'host' }
    expect(patchOf(test, { [PLUGIN_INTERFACE_PATH]: inventory([moved, FIELD], [INTERNAL]) })).toContain(`it removes service deloFixture (browser, in ${SERVICE_SOURCE}), adds service deloFixture (host, in ${SERVICE_SOURCE})`)
  })

  it('patch-rule-refuses-missing-inventory: an inventory missing or unreadable at the earlier release or at the release commit refuses', (test) => {
    const repo = repository(test)
    repo.commit({ ...facts('0.2.2'), [PLUGIN_INTERFACE_PATH]: null }, 'v0.1.2')
    const commit = repo.commit(facts('0.2.2'))
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.3', dsh: '0.2.2', commit, firstOfLine: false })).toBe(`release 0.1.3 is a patch of 0.1.2, and ${PLUGIN_INTERFACE_PATH} is missing at v0.1.2, so the rule cannot show the plugin-facing interface is unchanged; release it as 0.2.0`)
    expect(patchOf(test, { [PLUGIN_INTERFACE_PATH]: null })).toMatch(/^release 0\.1\.3 is a patch of 0\.1\.2, and delo\/packages\/contract-plugin-versions\/plugin-interface\.json is missing at [0-9a-f]{40}, so/u)
    expect(patchOf(test, { [PLUGIN_INTERFACE_PATH]: '{"schema":"delo.plugin-interface/1","covered":[],"covered":[],"internal":[]}' })).toContain(`${PLUGIN_INTERFACE_PATH} at `)
    expect(patchOf(test, { [PLUGIN_INTERFACE_PATH]: '{"schema":"delo.plugin-interface/2","covered":[],"internal":[]}' })).toContain('does not read: not a delo.plugin-interface/1 inventory')
  })

  it('patch-rule-allows-equal-patch: a patch with the same base, formats and covered interface passes, whatever its internal services and the order of its entries', (test) => {
    expect(patchOf(test, { 'delo/packages/fixture/src/fix.ts': 'export const fixed = true\n' })).toBeUndefined()
    expect(patchOf(test, { [PLUGIN_INTERFACE_PATH]: inventory([FIELD, SERVICE]) })).toBeUndefined()
  })

  it('patch-rule-skips-new-minor: the first release of a minor is no patch, so a moved base, format or interface passes', (test) => {
    const repo = repository(test)
    repo.commit(facts('0.2.1'), 'v0.1.0')
    repo.commit(facts('0.2.1'), 'v0.1.1')
    const commit = repo.commit({ ...facts('0.2.2'), [PERSISTENCE]: '{"schemaVersion":2}\n', [PLUGIN_INTERFACE_PATH]: inventory([FIELD]) })
    expect(earlierReleases(repo.path, '0.2.0')).toEqual([])
    expect(patchRuleProblem({ repository: repo.path, version: '0.2.0', dsh: '0.2.2', commit, firstOfLine: false })).toBeUndefined()
    expect(patchRuleProblem({ repository: repo.path, version: '1.0.0', dsh: '0.2.2', commit, firstOfLine: false })).toBeUndefined()
  })

  it('patch-rule-ignores-prerelease-tags: a pre-release tag is no existing release, and a pre-release of a patch is checked as the patch', (test) => {
    const repo = repository(test)
    repo.commit(facts('0.2.1', []), 'v0.1.2-rc.1')
    repo.commit(facts('0.2.1', []), 'vnext')
    repo.commit(facts('0.2.1', []), 'v00.1.0')
    repo.commit(facts('0.2.1', []), 'v1.1.0')
    repo.commit(facts('0.2.1', []), 'v0.1.5')
    const commit = repo.commit(facts('0.2.2', ['0.1.0-preview.1', '0.1.2-rc.1', '0.1.5', '1.1.0', '0.1.3']), 'v0.1.3')
    expect(earlierReleases(repo.path, '0.1.3')).toEqual([])
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.3', dsh: '0.2.2', commit, firstOfLine: true })).toBeUndefined()
    repo.commit(facts('0.2.1', ['0.1.1']), 'v0.1.1')
    repo.commit(facts('0.2.2', ['0.1.1', '0.1.2']), 'v0.1.2')
    const next = repo.commit(facts('0.2.2', ['0.1.1', '0.1.2']))
    expect(earlierReleases(repo.path, '0.1.3-rc.1')).toEqual([{ version: '0.1.2', tag: 'v0.1.2' }, { version: '0.1.1', tag: 'v0.1.1' }])
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.3-rc.1', dsh: '0.2.2', commit: next, firstOfLine: false })).toBe('release 0.1.3-rc.1 is a patch of 0.1.1 and moves DSH from 0.2.1 to 0.2.2; a release that moves the upstream base is at least a minor: release it as 0.2.0')
  })

  it('patch-rule-refuses-patch-without-earlier-release: a patch version with no earlier release of its line refuses unless the signer states it is the first of the line', (test) => {
    const repo = repository(test)
    const commit = repo.commit(facts('0.2.2', ['0.1.0-preview.1']))
    const request = { repository: repo.path, version: '0.1.3', dsh: '0.2.2', commit }
    expect(patchRuleProblem({ ...request, firstOfLine: false })).toBe(`release 0.1.3 is a patch version, but no earlier release of 0.1 is tagged here and listed in ${DATA_PATH}, so the patch rule has nothing to compare it with; a missing tag must not skip the rule: fetch the published tags (git fetch --tags) and sign again, or, when 0.1.3 is the first release of 0.1, sign with --first-of-line`)
    expect(patchRuleProblem({ ...request, version: '0.1.3-rc.1', firstOfLine: false })).toContain('release 0.1.3-rc.1 is a patch version, but no earlier release of 0.1 is tagged here')
    expect(patchRuleProblem({ ...request, firstOfLine: true })).toBeUndefined()
    expect(patchRuleProblem({ ...request, version: '0.2.0', firstOfLine: true })).toBe('--first-of-line is only for a patch version; release 0.2.0 is the first of 0.2 by its version, so sign it without --first-of-line')
    const tagged = repository(test)
    tagged.commit(facts('0.2.2'), 'v0.1.2')
    const after = tagged.commit(facts('0.2.2'))
    expect(patchRuleProblem({ ...request, repository: tagged.path, commit: after, firstOfLine: true })).toBe('--first-of-line states that release 0.1.3 is the first of 0.1, but v0.1.2 is tagged; sign without --first-of-line')
    expect(() => releaseLineProblem({ ...request, version: 'next', firstOfLine: false }, [])).toThrow('next is not a semantic version')
  })

  it('patch-rule-refuses-tag-on-wrong-commit: an earlier release tag whose commit is not an ancestor of the release commit refuses', (test) => {
    const repo = repository(test)
    const base = repo.commit(facts('0.2.2'), 'v0.1.2')
    const commit = repo.commit({ 'delo/packages/fixture/src/fix.ts': 'export const fixed = true\n' })
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.3', dsh: '0.2.2', commit, firstOfLine: false })).toBeUndefined()
    repo.git('checkout', '-q', '-b', 'side', base)
    const side = repo.commit({ 'side.txt': 'another line of history\n' })
    repo.git('tag', '-f', 'v0.1.2', side)
    expect(patchRuleProblem({ repository: repo.path, version: '0.1.3', dsh: '0.2.2', commit, firstOfLine: false })).toBe(`the tag v0.1.2 does not name an ancestor of the release commit ${commit}, so it is not the 0.1.2 that release 0.1.3 continues; delete the local tag, fetch the published tags (git fetch --tags) and sign again`)
  })

  it('patch-rule-refuses-release-missing-from-changelog: a tag the committed changelog does not list, a listed release without a tag, or no readable changelog refuses', (test) => {
    expect(patchOf(test, { [DATA_PATH]: changelog(['0.1.0-preview.1', '0.1.3']) })).toBe(`the tag v0.1.2 names release 0.1.2, which ${DATA_PATH} at the release commit does not list as assembled; a tag of a version never assembled is not a release, so delete the local tag, fetch the published tags (git fetch --tags) and sign again`)
    expect(patchOf(test, { [DATA_PATH]: changelog(['0.1.1', '0.1.2']) })).toBe(`${DATA_PATH} at the release commit lists release 0.1.1, but this repository has no tag v0.1.1, so the patch rule cannot compare release 0.1.3 with it; fetch the published tags (git fetch --tags) and sign again`)
    expect(patchOf(test, { [DATA_PATH]: null })).toMatch(new RegExp(`^release 0\\.1\\.3 is a patch version, and ${DATA_PATH} is missing at the release commit [0-9a-f]{40}, so the rule cannot cross-check the earlier releases of 0\\.1 that the tags name with the assembled versions it records$`, 'u'))
    expect(patchOf(test, { [DATA_PATH]: '{"schema":"delo.changelog/1","versions":[],"versions":[]}' })).toContain(`${DATA_PATH} at the release commit `)
    expect(patchOf(test, { [DATA_PATH]: '{"schema":"delo.changelog/1","versions":[{"version":"v0.1.2","previews":[]}]}' })).toContain('is not a delo.changelog/1 version list')
    expect(patchOf(test, { [DATA_PATH]: changelog(['0.1.2', '0.2.0', '1.1.0']) })).toBeUndefined()
    const folded = (preview: string): string => JSON.stringify({ schema: 'delo.changelog/1', versions: [{ version: '0.1.2', previews: [{ version: preview }] }] })
    expect(patchOf(test, { [DATA_PATH]: folded('0.1.2-rc.1') })).toBeUndefined()
    expect(patchOf(test, { [DATA_PATH]: folded('preview 1') })).toContain('is not a delo.changelog/1 version list')
  })

  it('reads the upstream version only from a string version in the app-boot package, and refuses a version that is not one', (test) => {
    const repo = repository(test)
    const versions = ['not json', 'null', '{}', '{"version":1}', '{"version":"0.2.2"}'].map(text => upstreamVersionAt(repo.path, repo.commit({ [UPSTREAM_VERSION_PATH]: text })))
    expect(versions).toEqual([undefined, undefined, undefined, undefined, '0.2.2'])
    expect(() => earlierReleases(repo.path, 'next')).toThrow('next is not a semantic version')
  })
})
