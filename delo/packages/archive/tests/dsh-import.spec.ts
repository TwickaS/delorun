/**
 * The stock-home import's plan and publication: what it carries and how it
 * lands, what it leaves behind with a reason, the profiles with each bundle
 * and plugin, the workspace list copied or joined, each category landing only
 * on its own yes, the DeepSeek key offered by name, and the stock home left
 * byte-identical.
 */
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDshHomeImport, readDshImportRecord, STOCK_IMPORT_DIRECTORY, type DshImportApplyOptions } from '../src/dsh-import/index.ts'
import { FILE_ALIAS, FILE_OBJECT, FIXTURE_SECRET, IMAGE, makeHomes, manifest, mark, plan, populate, PROJECT, read, registry, snapshot, type Homes } from './dsh-import-support.ts'

/** Every category taken. */
const ALL: DshImportApplyOptions = { include: { profiles: true, settings: true, instructions: true, skills: true, credentials: true } }

/** The data alone. */
const DATA: DshImportApplyOptions = { include: {} }

let homes: Homes

beforeEach(() => {
  homes = makeHomes()
})

afterEach(() => {
  homes.remove()
})

describe('the plan of a stock-home import', () => {
  it('names what it copies and what stays behind with a reason, and writes into neither home', async () => {
    populate(homes)
    const source = snapshot(homes.source)
    const planned = await plan(homes)
    expect(planned.chats.map(chat => [chat.path, chat.state, chat.files.map(file => file.path)])).toEqual([
      [`sessions/${PROJECT}/s1`, 'new', [`sessions/${PROJECT}/s1/session.v3.jsonl.zstd`, `sessions/${PROJECT}/s1/session.v4.jsonl.zstd`]],
      ['sessions/_no-cwd/s2', 'new', ['sessions/_no-cwd/s2/session.v4.jsonl.zstd']],
    ])
    expect(planned.attachments.map(file => file.path)).toEqual([FILE_OBJECT, FILE_ALIAS, IMAGE])
    expect(planned.registry).toMatchObject({ workspaces: 1, mode: 'copy' })
    expect(planned.profiles.map(profile => profile.name)).toEqual(['web'])
    expect(planned.layers.map(layer => [layer.target, layer.kind, layer.state, layer.carried])).toEqual([['cordis.patch.yml', 'home-patch', 'new', '[]\n'], ['settings.yaml', 'settings', 'new', 'ui-chat: {}\n']])
    expect(planned.instructions).toMatchObject({ state: 'new', text: '# notes\n', lines: 1 })
    expect(planned.skills.map(skill => [skill.path, skill.description, skill.bytes])).toEqual([['skills/review', 'Review a change', 59]])
    expect(planned.credentials?.entries).toEqual([{ name: 'DEEPSEEK_API_KEY', state: 'offered' }])
    expect(Object.fromEntries(planned.skipped.map(entry => [entry.path, entry.reason]))).toEqual({
      '.anonymous-user-id': 'identity',
      '.env': 'environment-file',
      'attachments/v1/request-images': 'cache',
      cache: 'cache',
      'dsh-runtimes': 'runtimes',
      logs: 'logs',
      mystery: 'unknown',
      'profiles/desktop': 'desktop-profile',
      'profiles/web/.plugin-manager': 'profile-history',
      'profiles/web/compatibility.json': 'version-exemptions',
      'profiles/web/lock': 'runtime-state',
      'profiles/web/node_modules': 'dependency-tree',
      'profiles/web/pnpm-lock.yaml': 'lockfile',
      'profiles/web/pnpm-workspace.yaml': 'build-approvals',
      runtimes: 'delo-entry',
      [`sessions/${PROJECT}/s1/session.lock`]: 'runtime-state',
      spill: 'spill',
      'storages/cua_permissions_ab12.json': 'permission-grants',
      'storages/schedule.json': 'scheduled-work',
      'storages/session_projcache.json': 'cache',
    })
    expect(planned.skippedTotals).toMatchObject({ 'runtime-state': 2, cache: 3, unknown: 1 })
    expect(planned.blockers).toEqual([])
    expect(planned.deloChats).toBe(0)
    expect(JSON.stringify(planned)).not.toContain(FIXTURE_SECRET)
    expect(snapshot(homes.source)).toEqual(source)
    expect(readdirSync(homes.target)).toEqual([])
  })

  it('lists each bundle and plugin of a profile as carried, to install, added or not carried', async () => {
    homes.write('profiles/web/package.json', manifest(
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-schedule-bundle', '@deepseek-ai/dsh-subagent-codex', 'local-bundle', 'registry-bundle', 'tagged-bundle', 'unknown-bundle', '@delo/other', 'Bad Name'],
      { 'local-bundle': 'file:/opt/local-bundle', 'registry-bundle': '^2.0.0', 'tagged-bundle': 'next', 'row-plugin': 'link:/opt/row-plugin', 'git-plugin': 'github:someone/plugin', 'alias-plugin': 'npm:other@1', 'Bad\u001bName': '1.0.0' },
    ))
    const [profile] = (await plan(homes)).profiles
    expect(profile?.plugins.map(plugin => [plugin.name, plugin.kind, plugin.status, plugin.note])).toEqual([
      ['@deepseek-ai/dsh-base', 'bundle', 'carried', 'ships with DeepSeek Harness'],
      ['@deepseek-ai/dsh-experimental-schedule-bundle', 'bundle', 'not-carried', 'retired by DeepSeek Harness'],
      ['@deepseek-ai/dsh-subagent-codex', 'bundle', 'install', 'an official bundle installed on demand'],
      ['local-bundle', 'bundle', 'not-carried', 'installed from "file:/opt/local-bundle", which is not a registry version; if you trust it, add it again yourself'],
      ['registry-bundle', 'bundle', 'install', 'from the registry, ^2.0.0'],
      ['tagged-bundle', 'bundle', 'install', 'from the registry, next'],
      ['unknown-bundle', 'bundle', 'install', 'the stock profile does not say where it comes from; add it by name'],
      ['@delo/other', 'bundle', 'carried', 'ships with Delo'],
      ['Bad Name', 'bundle', 'not-carried', 'not a package name'],
      ['row-plugin', 'plugin', 'not-carried', 'installed from "link:/opt/row-plugin", which is not a registry version; if you trust it, add it again yourself'],
      ['git-plugin', 'plugin', 'not-carried', 'installed from "github:someone/plugin", which is not a registry version; if you trust it, add it again yourself'],
      ['alias-plugin', 'plugin', 'not-carried', 'installed from "npm:other@1", which is not a registry version; if you trust it, add it again yourself'],
      ['Bad\u001bName', 'plugin', 'not-carried', 'not a package name'],
      ['@delo/bundle-local', 'bundle', 'added', 'Delo\'s own bundle, which keeps Delo\'s privacy defaults in this profile'],
    ])
    expect(JSON.parse(profile?.manifest ?? '')).toEqual({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'registry-bundle': '^2.0.0', 'tagged-bundle': 'next' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-subagent-codex', 'registry-bundle', 'tagged-bundle', 'unknown-bundle', '@delo/other', '@delo/bundle-local'] } },
    })
  })

  it('writes a profile manifest with no script, pnpm setting, override, path or other field of the stock one', async () => {
    homes.write('profiles/web/package.json', manifest(['@deepseek-ai/dsh-base', '@delo/bundle-local'], { 'registry-bundle': '1.2.3' }, {
      name: 'stock-name',
      scripts: { postinstall: 'node steal.js', preinstall: 'curl example.invalid' },
      pnpm: { overrides: { 'registry-bundle': 'file:/opt/evil' }, onlyBuiltDependencies: ['*'] },
      overrides: { x: 'link:/opt/evil' },
      resolutions: { y: 'file:/opt/evil' },
      bin: { tool: './tool.js' },
      main: './evil.js',
      workspaces: ['../../..'],
      packageManager: 'pnpm@1.0.0',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@delo/bundle-local'], hooks: './run.js' }, other: true },
    }))
    const [profile] = (await plan(homes)).profiles
    expect(JSON.parse(profile?.manifest ?? '')).toEqual({ name: 'dsh-profile-web', private: true, dependencies: { 'registry-bundle': '1.2.3' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@delo/bundle-local'] } } })
  })

  it('leaves a profile whole when its files cannot be read safely, and names why', async () => {
    homes.write('profiles/nomanifest/cordis.patch.yml', '[]\n')
    homes.write('profiles/notjson/package.json', '{')
    homes.write('profiles/array/package.json', '[]')
    homes.write('profiles/badlist/package.json', JSON.stringify({ dsh: { profile: { bundles: 'one' } } }))
    homes.write('profiles/badpatch/package.json', manifest([]))
    homes.write('profiles/badpatch/cordis.patch.yml', 'not: a list\n')
    homes.write('profiles/hugepatch/package.json', manifest([]))
    homes.write('profiles/hugepatch/cordis.patch.yml', Buffer.alloc(16 * 1024 * 1024 + 1, 0x20))
    homes.directory('profiles/dirmanifest/package.json')
    homes.write('profiles/huge/package.json', Buffer.alloc(16 * 1024 * 1024 + 1, 0x20))
    homes.write('profiles/default/package.json', manifest([]))
    homes.write('profiles/ok/package.json', manifest([]))
    homes.write('profiles/ok/delo-safety.json', '{"schema":"delo.profile-safety/1","ejected":[],"disabled":[]}')
    homes.writeTarget('profiles/ok/package.json', manifest([]))
    homes.write('profiles/bad;name/package.json', manifest([]))
    homes.write('profiles/node_modules/package.json', manifest([]))
    homes.write('profiles/fine/package.json', manifest(['@delo/bundle-local']))
    homes.write('profiles/fine/delo-safety.json', '{"schema":"delo.profile-safety/1","ejected":[],"disabled":[]}')
    homes.write('profiles/README.md', 'notes')
    homes.write('profiles/fine/notes.md', 'the profile\'s own notes')
    const planned = await plan(homes, { reservedProfiles: ['Default'] })
    const reasons = Object.fromEntries(planned.skipped.map(entry => [entry.path, [entry.reason, entry.detail]]))
    expect(reasons['profiles/nomanifest']).toEqual(['unreadable', 'it holds no package.json'])
    expect(reasons['profiles/notjson']).toEqual(['unreadable', 'its package.json is not JSON'])
    expect(reasons['profiles/array']).toEqual(['unreadable', 'its package.json is not a JSON object'])
    expect(reasons['profiles/badlist']).toEqual(['unreadable', 'its bundle list is not a list of package names'])
    expect(reasons['profiles/hugepatch']).toEqual(['too-large', `its cordis.patch.yml holds ${String(16 * 1024 * 1024 + 1)} bytes`])
    expect(reasons['profiles/dirmanifest']).toEqual(['unknown', 'its package.json is a directory'])
    expect(reasons['profiles/huge']).toEqual(['too-large', `its package.json holds ${String(16 * 1024 * 1024 + 1)} bytes`])
    expect(reasons['profiles/default']).toEqual(['taken', undefined])
    expect(reasons['profiles/ok']).toEqual(['taken', undefined])
    expect(reasons['profiles/bad;name']).toEqual(['unsafe-name', undefined])
    expect(reasons['profiles/node_modules']).toEqual(['unsafe-name', undefined])
    expect(reasons['profiles/README.md']).toEqual(['unknown', undefined])
    expect(reasons['profiles/fine/delo-safety.json']).toEqual(['delo-entry', undefined])
    expect(reasons['profiles/fine/notes.md']).toEqual(['unknown', undefined])
    expect(planned.profiles.map(profile => [profile.name, profile.patch?.held])).toEqual([['badpatch', [{ label: 'the whole file', reason: 'shape' }]], ['fine', undefined]])
  })

  it('holds back every row with an expression, and says which rows of a home patch do not carry', async () => {
    homes.write('profiles/web/package.json', manifest(['@deepseek-ai/dsh-base']))
    homes.write('profiles/web/cordis.patch.yml', '- id: ui-chat\n  config:\n    compact: !!js true\n    other: !js "x"\n- id: ui-theme\n  config:\n    preference: dark\n')
    homes.write('cordis.patch.yml', '- insert:\n    - id: stock-row\n      name: \'@deepseek-ai/dsh-ui-chat\'\n- id: stock-config\n  config:\n    on: !!js true\n')
    homes.writeTarget('cordis.patch.yml', '- insert:\n    - id: delo-row\n      name: delo-plugin\n')
    const planned = await plan(homes, { planId: 'p1' })
    const patch = planned.profiles[0]?.patch
    expect(patch).toMatchObject({ kind: 'profile-patch', state: 'new', carried: '- id: ui-theme\n  config:\n    preference: dark\n', carriedLabels: ['ui-theme'], held: [{ label: 'ui-chat', reason: 'expression' }], heldPath: `${STOCK_IMPORT_DIRECTORY}/import-p1/held/profiles/web/cordis.patch.yml`, expressions: 2 })
    expect(patch?.heldText).toContain('compact: !!js "true"')
    expect(patch?.heldText).toContain('# held back: it holds a !!js expression')
    expect(planned.profiles[0]?.carry).toEqual([
      'The stock home patch\'s row stock-row will not apply: the Delo home keeps its own home patch.',
      'The settings for ui-chat do not land in this profile: they are held back.',
      'The stock home patch\'s settings for stock-config will not apply: the Delo home keeps its own home patch.',
      'The Delo home patch\'s row delo-row will apply to this profile too.',
    ])
    expect(planned.layers).toMatchObject([{ target: 'cordis.patch.yml', state: 'taken', carried: undefined, held: [{ label: 'the whole file', reason: 'taken' }], expressions: 1 }])
  })

  it('carries a profile under the Delo home\'s own home patch when the stock home has none', async () => {
    homes.write('profiles/web/package.json', manifest(['@deepseek-ai/dsh-base']))
    homes.writeTarget('cordis.patch.yml', '- id: delo-config\n  config:\n    x: 1\n')
    expect((await plan(homes)).profiles[0]?.carry).toEqual(['The Delo home patch\'s settings for delo-config will apply to this profile too.'])
  })

  it('says when a home patch the profile runs under cannot be read', async () => {
    homes.write('profiles/web/package.json', manifest(['@deepseek-ai/dsh-base']))
    homes.write('cordis.patch.yml', '[]\n')
    homes.writeTarget('cordis.patch.yml', 'not: a list\n')
    const note = 'A patch layer this profile runs under cannot be read, so whether its rows carry is not known; check the profile after the import.'
    expect((await plan(homes)).profiles[0]?.carry).toEqual([note])
    rmSync(join(homes.target, 'cordis.patch.yml'))
    homes.writeTarget('cordis.patch.yml/inside', 'a directory')
    expect((await plan(homes)).profiles[0]?.carry).toEqual([note])
  })

  it('leaves a home patch too large to read behind, and leaves its rows out of the carry check', async () => {
    homes.write('cordis.patch.yml', Buffer.alloc(16 * 1024 * 1024 + 1, 0x20))
    homes.write('profiles/web/package.json', manifest(['@deepseek-ai/dsh-base']))
    const planned = await plan(homes, { limits: { maxEntries: 100, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 } })
    expect(planned.layers).toEqual([])
    expect(planned.skipped).toContainEqual({ path: 'cordis.patch.yml', reason: 'too-large', detail: `it holds ${String(16 * 1024 * 1024 + 1)} bytes` })
    expect(planned.profiles[0]?.carry).toEqual([])
  })

  it('leaves an attachment behind whose bytes are not the content its path names', async () => {
    mark(homes)
    homes.write(IMAGE, 'other bytes than the address')
    homes.write('attachments/v1/objects/ab/abcd', 'a name that is no digest')
    homes.write(`attachments/v1/objects/11/${'0'.repeat(63)}1`, 'a prefix that is not the digest\'s')
    homes.write(FILE_OBJECT, 'file-bytes')
    homes.write(`${FILE_ALIAS}/../extra/deeper`, 'file-bytes')
    const planned = await plan(homes)
    expect(planned.attachments.map(file => file.path)).toEqual([FILE_OBJECT])
    expect(planned.skipped.filter(entry => entry.reason === 'not-addressed').map(entry => [entry.path, entry.detail])).toEqual([
      [`${FILE_ALIAS.slice(0, FILE_ALIAS.lastIndexOf('/'))}/extra/deeper`, 'its path names no content address'],
      [`attachments/v1/objects/11/${'0'.repeat(63)}1`, 'its path names no content address'],
      [IMAGE, undefined],
      ['attachments/v1/objects/ab/abcd', 'its path names no content address'],
    ])
  })

  it('reads a skill\'s description from its front matter when it declares one the plan reads', async () => {
    mark(homes)
    homes.write('skills/none/run.sh', 'echo')
    homes.write('skills/plain/SKILL.md', '# no front matter\n')
    homes.write('skills/empty/SKILL.md', '---\ndescription: "  "\n---\n')
    homes.write('skills/number/SKILL.md', '---\ndescription: 7\n---\n')
    homes.write('skills/lines/SKILL.md', '---\ndescription: |\n  First line\n  Second line\n---\n')
    homes.write('skills/huge/SKILL.md', Buffer.alloc(1024 * 1024 + 1, 0x20))
    const planned = await plan(homes)
    expect(planned.skipped).toContainEqual({ path: 'skills/huge', reason: 'too-large', detail: `its SKILL.md holds ${String(1024 * 1024 + 1)} bytes, more than the import shows` })
    expect(planned.skills.map(skill => [skill.path, skill.description])).toEqual([
      ['skills/empty', undefined],
      ['skills/lines', 'First line'],
      ['skills/none', undefined],
      ['skills/number', undefined],
      ['skills/plain', undefined],
    ])
  })

  it('leaves earlier settings too large to read behind, and keeps the Delo home\'s home patch for profiles', async () => {
    homes.write('settings.yaml', Buffer.alloc(16 * 1024 * 1024 + 1, 0x20))
    homes.write('profiles/web/package.json', manifest(['@deepseek-ai/dsh-base']))
    const planned = await plan(homes, { limits: { maxEntries: 100, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 } })
    expect(planned.layers).toEqual([])
    expect(planned.skipped).toContainEqual({ path: 'settings.yaml', reason: 'too-large', detail: `it holds ${String(16 * 1024 * 1024 + 1)} bytes` })
  })

  it('lists at most a hundred entries per reason and counts every one', async () => {
    mark(homes)
    for (let index = 0; index < 120; index += 1) homes.write(`mystery-${String(index).padStart(3, '0')}`, 'x')
    const planned = await plan(homes)
    expect(planned.skipped.filter(entry => entry.reason === 'unknown')).toHaveLength(100)
    expect(planned.skippedTotals.unknown).toBe(120)
  })

  it('refuses a directory that holds root names alone, without a chat, a profile manifest or a workspace list', async () => {
    homes.write('AGENTS.md', '# notes\n')
    homes.write('profiles/web/cordis.patch.yml', '[]\n')
    homes.write('sessions/_no-cwd/s1/notes.txt', 'x')
    await expect(plan(homes)).rejects.toThrow(/is not a DeepSeek Harness home: it holds no chat, no profile with a package\.json and no workspace list/u)
    homes.write('sessions/--flat--/s3.jsonl.zstd', 'x')
    expect((await plan(homes)).skipped).toContainEqual({ path: 'sessions/--flat--', reason: 'legacy-layout', detail: 'it holds chats in the flat-file layout' })
  })
})

describe('the publication of a stock-home import', () => {
  it('copies the data byte for byte into private directories, lands no category without a yes, and leaves the stock home byte-identical', async () => {
    populate(homes)
    const source = snapshot(homes.source)
    const planned = await plan(homes)
    const report = await applyDshHomeImport(planned, { ...DATA, now: () => new Date('2026-11-10T00:00:00.000Z') })
    expect(snapshot(homes.source)).toEqual(source)
    const skipped = Object.values(planned.skippedTotals).reduce((sum, count) => sum + count, 0)
    expect(report).toEqual({
      chats: 2,
      chatsPresent: 0,
      attachments: 3,
      workspaces: { count: 1, mode: 'copy' },
      profiles: [],
      documents: [],
      held: [],
      skills: 0,
      credentials: [],
      skipped,
      bytes: planned.bytes,
    })
    for (const path of [`sessions/${PROJECT}/s1/session.v4.jsonl.zstd`, `sessions/${PROJECT}/s1/session.v3.jsonl.zstd`, 'sessions/_no-cwd/s2/session.v4.jsonl.zstd', IMAGE]) {
      expect(read(homes.target, path)).toBe(read(homes.source, path))
    }
    // The list is written from its parsed and checked value, so it holds the same records, not the same bytes.
    expect(JSON.parse(read(homes.target, 'storages/workspace.json'))).toEqual(JSON.parse(read(homes.source, 'storages/workspace.json')))
    expect(statSync(join(homes.target, 'sessions')).mode & 0o777).toBe(0o700)
    expect(statSync(join(homes.target, `sessions/${PROJECT}/s1`)).mode & 0o777).toBe(0o700)
    expect(statSync(join(homes.target, IMAGE)).mode & 0o777).toBe(0o400)
    // An attachment alias keeps sharing its object's inode, as upstream's store writes it.
    expect(lstatSync(join(homes.target, FILE_ALIAS)).ino).toBe(lstatSync(join(homes.target, FILE_OBJECT)).ino)
    for (const absent of ['profiles', 'cordis.patch.yml', 'settings.yaml', 'AGENTS.md', 'skills', '.credentials.yaml', '.env', 'logs', 'cache', 'storages/schedule.json', 'mystery', 'runtimes', `sessions/${PROJECT}/s1/session.lock`]) {
      expect(existsSync(join(homes.target, absent))).toBe(false)
    }
    expect(readdirSync(join(homes.target, STOCK_IMPORT_DIRECTORY))).toEqual(['imports.json'])
    expect(statSync(join(homes.target, STOCK_IMPORT_DIRECTORY, 'imports.json')).mode & 0o777).toBe(0o600)
    expect(await readDshImportRecord(homes.target)).toEqual([{ at: '2026-11-10T00:00:00.000Z', source: homes.source, chats: 2, sessions: ['s1', 's2'], workspaces: 1, profiles: [], categories: [], credentials: [], skipped }])
  })

  it('lands every category after a yes to each: the profile as it was shown, the settings, the instructions, the skills and the key', async () => {
    populate(homes)
    const planned = await plan(homes, { planId: 'p2' })
    const report = await applyDshHomeImport(planned, ALL)
    expect(report).toMatchObject({ profiles: ['web'], documents: ['profiles/web/cordis.patch.yml', 'cordis.patch.yml', 'settings.yaml', 'AGENTS.md'], held: [], skills: 1, credentials: ['DEEPSEEK_API_KEY'] })
    expect(read(homes.target, 'profiles/web/package.json')).toBe(planned.profiles[0]?.manifest)
    expect(JSON.parse(read(homes.target, 'profiles/web/package.json'))).toEqual({ name: 'dsh-profile-web', private: true, dependencies: { 'third-party-bundle': '^1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party-bundle', '@delo/bundle-local'] } } })
    expect(read(homes.target, 'profiles/web/cordis.patch.yml')).toBe('- id: ui-chat\n  config:\n    linkOpening: new-tab\n')
    // The pnpm settings are upstream's own for a new profile: no build is approved.
    expect(read(homes.target, 'profiles/web/pnpm-workspace.yaml')).not.toContain('allowBuilds')
    for (const absent of ['profiles/web/compatibility.json', 'profiles/web/pnpm-lock.yaml', 'profiles/web/node_modules', 'profiles/web/.plugin-manager', 'profiles/desktop']) {
      expect(existsSync(join(homes.target, absent))).toBe(false)
    }
    for (const path of ['AGENTS.md', 'skills/review/SKILL.md', 'settings.yaml', 'cordis.patch.yml']) expect(read(homes.target, path)).toBe(read(homes.source, path))
    expect(statSync(join(homes.target, 'AGENTS.md')).mode & 0o777).toBe(0o600)
    expect(read(homes.target, '.credentials.yaml')).toContain(FIXTURE_SECRET)
    expect((await readDshImportRecord(homes.target))[0]).toMatchObject({ profiles: ['web'], categories: ['profiles', 'settings', 'instructions', 'skills', 'credentials'], credentials: ['DEEPSEEK_API_KEY'] })
    expect(JSON.stringify(report)).not.toContain(FIXTURE_SECRET)
  })

  it('writes the held-back rows where nothing reads them, and a profile whose patch is held back whole starts from upstream\'s empty patch', async () => {
    mark(homes)
    homes.write('profiles/web/package.json', manifest(['@deepseek-ai/dsh-base']))
    homes.write('profiles/web/cordis.patch.yml', '- id: x\n  config: &shared\n    a: 1\n')
    homes.write('cordis.patch.yml', '- id: sandbox\n  config:\n    runnerCommand: [/bin/sh]\n- id: locale\n  config:\n    preference: en\n')
    const planned = await plan(homes, { planId: 'p3' })
    const report = await applyDshHomeImport(planned, ALL)
    const held = `${STOCK_IMPORT_DIRECTORY}/import-p3/held`
    expect(report.held).toEqual([`${held}/profiles/web/cordis.patch.yml`, `${held}/cordis.patch.yml`])
    expect(read(homes.target, 'profiles/web/cordis.patch.yml')).toContain('[]')
    expect(read(homes.target, `${held}/profiles/web/cordis.patch.yml`)).toContain('anchors, aliases or merge keys')
    expect(read(homes.target, 'cordis.patch.yml')).toBe('- id: locale\n  config:\n    preference: en\n')
    expect(read(homes.target, `${held}/cordis.patch.yml`)).toContain('runnerCommand')
    expect(statSync(join(homes.target, `${held}/cordis.patch.yml`)).mode & 0o777).toBe(0o600)
  })

  it('offers the DeepSeek key alone, copies it only after a yes, at mode 0600, beside the keys the Delo home holds', async () => {
    mark(homes)
    homes.write('.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}\n  OTHER_KEY: stock-value\nrecords:\n  llm-deepseek/main:\n    kind: api-key\n    key: record-secret\n    env:\n      DEEPSEEK_BASE_URL: https://collector.invalid\n  llm-openai/main:\n    kind: api-key\n    key: openai-secret\n`, 0o600)
    homes.writeTarget('.credentials.yaml', 'version: 1\nrefs:\n  OTHER_KEY: delo-value\n', 0o600)
    const planned = await plan(homes)
    expect(planned.credentials?.entries).toEqual([
      { name: 'DEEPSEEK_API_KEY', state: 'offered' },
      { name: 'OTHER_KEY', state: 'not-carried' },
      { name: 'llm-deepseek/main', state: 'offered' },
      { name: 'llm-openai/main', state: 'not-carried' },
    ])
    const report = await applyDshHomeImport(planned, ALL)
    expect(report.credentials).toEqual(['DEEPSEEK_API_KEY', 'llm-deepseek/main'])
    const landed = read(homes.target, '.credentials.yaml')
    expect(landed).toContain(`DEEPSEEK_API_KEY: ${FIXTURE_SECRET}`)
    expect(landed).toContain('OTHER_KEY: delo-value')
    expect(landed).toContain('key: record-secret')
    // A record's environment map can name another endpoint, so only its key lands.
    expect(landed).not.toContain('collector.invalid')
    expect(landed).not.toContain('openai-secret')
    expect(statSync(join(homes.target, '.credentials.yaml')).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(await readDshImportRecord(homes.target))).not.toContain(FIXTURE_SECRET)
  })

  it('leaves the Delo home\'s credentials untouched without a yes, and writes a new document when it has none', async () => {
    mark(homes)
    homes.write('.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}\n`, 0o600)
    await applyDshHomeImport(await plan(homes), DATA)
    expect(existsSync(join(homes.target, '.credentials.yaml'))).toBe(false)
    homes.remove()
    homes = makeHomes()
    mark(homes)
    homes.write('.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}\n`, 0o600)
    await applyDshHomeImport(await plan(homes), ALL)
    expect(read(homes.target, '.credentials.yaml')).toBe(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}\n`)
  })

  it('writes nothing for a key the Delo home already holds or holds another value of, and adds a version to an empty document', async () => {
    mark(homes)
    homes.write('.credentials.yaml', 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: same-value\nrecords:\n  llm-deepseek/a:\n    kind: api-key\n    key: one\n', 0o600)
    homes.writeTarget('.credentials.yaml', 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: same-value\nrecords:\n  llm-deepseek/a:\n    kind: api-key\n    key: two\n', 0o600)
    expect((await plan(homes)).credentials?.entries).toEqual([{ name: 'DEEPSEEK_API_KEY', state: 'present' }, { name: 'llm-deepseek/a', state: 'taken' }])
    expect((await applyDshHomeImport(await plan(homes), ALL)).credentials).toEqual([])
    homes.write('.credentials.yaml', 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: new-value\n', 0o600)
    homes.writeTarget('.credentials.yaml', '', 0o600)
    await applyDshHomeImport(await plan(homes, { merge: true }), ALL)
    expect(read(homes.target, '.credentials.yaml')).toBe('version: 1\nrefs:\n  DEEPSEEK_API_KEY: new-value\n')
  })

  it('lists the credentials as unreadable when either document is not one upstream reads, and never quotes a value', async () => {
    mark(homes)
    homes.write('.credentials.yaml', `refs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}\n`, 0o600)
    const stockFlat = await plan(homes)
    expect(stockFlat.credentials).toBeUndefined()
    expect(stockFlat.skipped[0]).toMatchObject({ path: '.credentials.yaml', reason: 'unreadable' })
    expect(JSON.stringify(stockFlat)).not.toContain(FIXTURE_SECRET)
    homes.write('.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}\n`, 0o600)
    homes.writeTarget('.credentials.yaml', 'version: 2\n', 0o600)
    const deloBad = await plan(homes)
    expect(deloBad.skipped[0]?.detail).toContain('the Delo home\'s credentials document cannot be read')
    homes.remove()
    homes = makeHomes()
    mark(homes)
    homes.write('.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}\n`, 0o600)
    homes.writeTarget('.credentials.yaml/inside', 'a directory')
    expect((await plan(homes)).skipped[0]?.detail).toContain('it is not a file')
  })

  it('treats a home that holds the same files as already holding them, so a second import copies no chat', async () => {
    populate(homes)
    await applyDshHomeImport(await plan(homes), ALL)
    const again = await plan(homes, { merge: true })
    expect(again.chats.map(chat => chat.state)).toEqual(['present', 'present'])
    expect(again.attachments).toEqual([])
    expect(again.attachmentsPresent).toBe(3)
    expect(again.registry?.mode).toBe('present')
    expect(again.layers.map(layer => layer.state)).toEqual(['present', 'present'])
    expect(again.instructions?.state).toBe('present')
    expect(again.skipped).toContainEqual({ path: 'profiles/web', reason: 'taken' })
    expect(again.skipped).toContainEqual({ path: 'skills/review', reason: 'taken' })
    const report = await applyDshHomeImport(again, ALL)
    expect(report).toMatchObject({ chats: 0, chatsPresent: 2, attachments: 0, documents: [] })
    expect(await readDshImportRecord(homes.target)).toHaveLength(2)
  })

  it('leaves the instructions behind when the Delo home holds its own', async () => {
    mark(homes)
    homes.write('AGENTS.md', '# stock notes\n')
    homes.writeTarget('AGENTS.md', '# delo notes\n')
    const planned = await plan(homes)
    expect(planned.instructions).toBeUndefined()
    expect(planned.skipped).toContainEqual({ path: 'AGENTS.md', reason: 'taken' })
  })

  it('reads an unreadable import record as none, and writes a new one', async () => {
    mark(homes)
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/imports.json`, 'not json')
    expect(await readDshImportRecord(homes.target)).toEqual([])
    await applyDshHomeImport(await plan(homes), DATA)
    expect(await readDshImportRecord(homes.target)).toHaveLength(1)
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/imports.json`, '{"v":1}')
    expect(await readDshImportRecord(homes.target)).toEqual([])
  })
})

describe('the workspace list of a stock-home import', () => {
  it('joins the stock workspaces to the Delo home\'s list: a folder it registers gains the chats, any other is added after its own', async () => {
    homes.write(`sessions/${PROJECT}/s1/session.v4.jsonl.zstd`, 'one')
    homes.write('sessions/--work-other--/s3/session.v4.jsonl.zstd', 'three')
    homes.write('storages/workspace.json', registry({ w1: { path: '/work/proj', sessionIds: ['s1'] }, w2: { path: '/work/other', sessionIds: ['s3', 'dup'] }, w4: { path: '/work/delo', sessionIds: ['s4'] } }, { archivedSessionIds: ['s3'], pinnedSessionIds: ['s1'] }))
    const delo = registry({ d1: { path: '/work/proj', sessionIds: ['d-chat', 'dup'] }, w4: { path: '/work/delo', sessionIds: ['s4'] } })
    homes.writeTarget('storages/workspace.json', delo)
    const planned = await plan(homes)
    expect(planned.registry).toMatchObject({ workspaces: 3, mode: 'merge' })
    await applyDshHomeImport(planned, DATA)
    const merged = JSON.parse(read(homes.target, 'storages/workspace.json')) as { global: { workspaceIds: string[], archivedSessionIds: string[], pinnedSessionIds: string[] }, tables: { workspaces: Record<string, { path: string, sessionIds: string[], title: string }> } }
    expect(merged.global.workspaceIds).toEqual(['d1', 'w4', 'w2'])
    expect(merged.tables.workspaces['d1']).toMatchObject({ path: '/work/proj', title: 'd1', sessionIds: ['d-chat', 'dup', 's1'] })
    expect(merged.tables.workspaces['w2']).toMatchObject({ path: '/work/other', sessionIds: ['s3'] })
    expect(merged.global.archivedSessionIds).toEqual(['s3'])
    expect(merged.global.pinnedSessionIds).toEqual(['s1'])
  })

  it('adds a stock chat to a workspace both lists hold, and finds nothing to add when the Delo list already holds it all', async () => {
    homes.write('storages/workspace.json', registry({ w1: { path: '/work/proj', sessionIds: ['s1', 's2'] } }))
    homes.write(`sessions/${PROJECT}/s2/session.v4.jsonl.zstd`, 'two')
    homes.writeTarget('storages/workspace.json', registry({ w1: { path: '/work/proj', sessionIds: ['s1'] } }))
    await applyDshHomeImport(await plan(homes), DATA)
    expect((JSON.parse(read(homes.target, 'storages/workspace.json')) as { tables: { workspaces: { w1: { sessionIds: string[] } } } }).tables.workspaces.w1.sessionIds).toEqual(['s1', 's2'])
    expect((await plan(homes)).registry?.mode).toBe('present')
    homes.write('storages/workspace.json', registry({ w9: { path: '/work/proj', sessionIds: ['s1'] } }))
    expect((await plan(homes)).registry?.mode).toBe('present')
  })

  it('refuses to join two lists that hold one identifier for different folders, or a list interrupted mid-change', async () => {
    homes.write('storages/workspace.json', registry({ w1: { path: '/work/one', sessionIds: [] } }))
    homes.writeTarget('storages/workspace.json', registry({ w1: { path: '/work/two', sessionIds: [] } }))
    const collided = await plan(homes)
    expect(collided.blockers.map(blocker => blocker.code)).toEqual(['DSH_IMPORT_ID_COLLISION'])
    await expect(applyDshHomeImport(collided, DATA)).rejects.toMatchObject({ code: 'DSH_IMPORT_ID_COLLISION' })
    homes.writeTarget('storages/workspace.json', registry({ w1: { path: '/work/one', sessionIds: [] } }, { pendingMutation: { operation: 'create', workspaceId: 'w1' } }))
    expect((await plan(homes)).blockers[0]?.message).toContain('start Delo once')
    homes.writeTarget('storages/workspace.json', registry({}))
    homes.write('storages/workspace.json', registry({ w1: { path: '/work/one', sessionIds: [] } }, { pendingMutation: { operation: 'delete', workspaceId: 'w0' } }))
    expect((await plan(homes)).blockers[0]?.message).toContain('start DeepSeek Harness once')
  })

  it('refuses a Delo list it cannot read, and leaves a stock list it cannot read behind', async () => {
    homes.write('storages/workspace.json', registry({}))
    homes.writeTarget('storages/workspace.json', '{')
    expect((await plan(homes)).blockers[0]).toMatchObject({ code: 'DSH_IMPORT_REGISTRY_REFUSED' })
    rmSync(join(homes.target, 'storages/workspace.json'))
    homes.writeTarget('storages/workspace.json/inside', 'directory')
    expect((await plan(homes)).blockers[0]?.message).toContain('it is not a file')
    const cases: [string, string][] = [
      ['{', 'it is not JSON'],
      ['[]', 'it is not a version 2 workspace unit'],
      [JSON.stringify({ unit: { name: 'workspace', version: 1 } }), 'it is not a version 2 workspace unit'],
      [JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: 'yes' } }), 'its registry state does not match the workspace schema'],
      [JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: null, tables: { workspaces: [] } }), 'its workspace table is not a mapping'],
      [JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: null, tables: { workspaces: { w: { path: 1 } } } }), 'its workspace "w" does not match the workspace schema'],
      [registry({}, { workspaceIds: ['w'] }), 'its order repeats a workspace or names one it does not hold'],
      [JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [] }, tables: { workspaces: JSON.parse(registry({ w: { path: '/a', sessionIds: [] } })).tables.workspaces } }), 'it holds a workspace its order does not name'],
      [registry({ a: { path: '/a', sessionIds: [] }, b: { path: '/a', sessionIds: [] } }), 'two of its workspaces claim one folder'],
      [registry({ a: { path: '/a', sessionIds: ['s'] }, b: { path: '/b', sessionIds: ['s'] } }), 'two of its workspaces claim one chat'],
    ]
    for (const [text, detail] of cases) {
      homes.remove()
      homes = makeHomes()
      homes.write('storages/workspace.json', text)
      const planned = await plan(homes)
      expect(planned.registry).toBeUndefined()
      expect(planned.skipped).toEqual([{ path: 'storages/workspace.json', reason: 'unreadable', detail }])
    }
  })

  it('reads a list that holds no state yet, and carries it as it is', async () => {
    homes.write('storages/workspace.json', JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: null }))
    expect((await plan(homes)).registry).toMatchObject({ workspaces: 0, mode: 'copy' })
  })
})
