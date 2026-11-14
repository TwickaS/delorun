import { describe, expect, it } from 'vitest'
import { appliesTo, applyRules, CONTENT_SKIP, GUARDS, planPathRenames, renamePath, RULES, type ReplaceRule } from '../../src/rename/rules.ts'

const rename = (text: string): string => applyRules(text, 'docs/example.md').text

/** Before and after, one row per case the rename must get right. */
const TABLE: readonly (readonly [label: string, before: string, after: string])[] = [
  ['npm scope', '@delo/cli', '@delorun/cli'],
  ['import specifier', "import { x } from '@delo/contract-relay-protocol'", "import { x } from '@delorun/contract-relay-protocol'"],
  ['environment variable', 'DELO_FULL_GATE=1', 'DELORUN_FULL_GATE=1'],
  ['environment variable in a string', "process.env['DELO_HOME']", "process.env['DELORUN_HOME']"],
  ['home path', '~/.delo/logs', '~/.delorun/logs'],
  ['derived trash name', '.delo-trash', '.delorun-trash'],
  ['derived test name', 'mkdtemp(".delo-test")', 'mkdtemp(".delorun-test")'],
  ['schema string', 'delo.update-report/1', 'delorun.update-report/1'],
  ['package field', '"delo": ">=0.1.0"', '"delorun": ">=0.1.0"'],
  ['member access', 'engines.delo and versions.to.delo', 'engines.delorun and versions.to.delorun'],
  ['cookie', '__Host-delo-session', '__Host-delorun-session'],
  ['header scheme', 'Authorization: Delo-Tunnel <token>', 'Authorization: Delorun-Tunnel <token>'],
  ['subprotocol', 'delo-relay.v1', 'delorun-relay.v1'],
  ['ledger class', "'delo-feature'", "'delorun-feature'"],
  ['merge driver', 'merge=delo-ledger', 'merge=delorun-ledger'],
  ['directory in a path', 'delo/apps/tools/src/run-checks.ts', 'delorun/apps/tools/src/run-checks.ts'],
  ['repository path after an organisation URL', 'https://github.com/Delo-Run/delo/tree/v5/delo/apps', 'https://github.com/Delo-Run/delo/tree/v5/delorun/apps'],
  ['skill name', '.agents/skills/delo-dev-workflow/', '.agents/skills/delorun-dev-workflow/'],
  ['scratch prefix', 'mkdtemp(join(tmpdir(), "delo-scratch-"))', 'mkdtemp(join(tmpdir(), "delorun-scratch-"))'],
  ['escaped newline before the name', String.raw`console.log(\`\ndelo checks\`)`, String.raw`console.log(\`\ndelorun checks\`)`],
  ['camelCase lead', 'const deloOnboarding = 1', 'const delorunOnboarding = 1'],
  ['camelCase member', 'ctx.deloWorkspaces.list()', 'ctx.delorunWorkspaces.list()'],
  ['PascalCase', 'class DeloNotice {}', 'class DelorunNotice {}'],
  ['PascalCase inside', 'resolveDeloHome(isDelo)', 'resolveDelorunHome(isDelorun)'],
  ['product name', 'Delo keeps its state in ~/.delo.', 'Delorun keeps its state in ~/.delorun.'],
  ['possessive', "Delo's logs and delo's slug", "Delorun's logs and delorun's slug"],
  ['heading anchor of a possessive', '(#writing-delos-documentation)', '(#writing-deloruns-documentation)'],
  ['heading anchor with a hyphenated apostrophe', '/agent-notes/delo-s-notes:', '/agent-notes/delorun-s-notes:'],
  ['Chinese text', 'Delo 的笔记与 Delo的主页', 'Delorun 的笔记与 Delorun的主页'],
  ['provider id', '/auth/oidc/callback/delo-run', '/auth/oidc/callback/delorun'],
  ['hyphenated word of a longer name', 'delo-runtime-closure', 'delorun-runtime-closure'],
  ['organisation heading anchors stay', '[Delo Run mailbox](#delo-run-mailbox) /what-delo-run-can-and-cannot-do /x/delo-run-issuer', '[Delo Run mailbox](#delo-run-mailbox) /what-delo-run-can-and-cannot-do /x/delo-run-issuer'],
  ['check slot files', 'delo-run-checks.lock', 'delorun-checks.lock'],
  ['run-suffixed constant', 'DELO_RUN_CALLBACK_PATH', 'DELORUN_CALLBACK_PATH'],
  ['Runtime identifier is not a Run suffix', 'deloRuntime', 'delorunRuntime'],
  ['organisation name stays', 'Delo Run maintains Delo', 'Delo Run maintains Delorun'],
  ['organisation name in Chinese stays', 'Delo Run 信箱', 'Delo Run 信箱'],
  ['domain stays', 'your-name.delo.run and delo.run', 'your-name.delo.run and delo.run'],
  ['domain with a port stays', 'https://delo.run:8443/x', 'https://delo.run:8443/x'],
  ['reverse domain label stays', "home: 'run.delo.home'", "home: 'run.delo.home'"],
  ['GitHub repository stays', 'github.com/Delo-Run/delo and Delo-Run/delo-plugins', 'github.com/Delo-Run/delo and Delo-Run/delo-plugins'],
  ['GitHub organisation alone stays', 'a `Delo-Run` repository', 'a `Delo-Run` repository'],
  ['registry organisation stays, image is renamed', 'ghcr.io/delo-run/delo-workspace-s2', 'ghcr.io/delo-run/delorun-workspace-s2'],
  ['delorun is unchanged', 'delorun and Delorun and DELORUN and @delorun/cli', 'delorun and Delorun and DELORUN and @delorun/cli'],
  ['delorun domain is unchanged', 'support@delorun.com and docs.delorun.com', 'support@delorun.com and docs.delorun.com'],
  ['run-suffixed identifier', 'deloRunKeyOverlapMs', 'delorunKeyOverlapMs'],
  ['model inside Spanish and Portuguese words', 'los modelos y o Modelo, modelo', 'los modelos y o Modelo, modelo'],
  ['model identifiers', 'modelOverrides and PiAiModelOverride and MODELO', 'modelOverrides and PiAiModelOverride and MODELO'],
  ['download inside a word', 'codeload.github.com', 'codeload.github.com'],
  ['capitalised word that continues in lowercase', 'Deloitte', 'Deloitte'],
  ['upstream identifiers', 'dsh DSH_HOME @deepseek-ai/dsh-core', 'dsh DSH_HOME @deepseek-ai/dsh-core'],
  ['opaque run keeps a chance match', `sha512-${'A'.repeat(20)}Delo${'B'.repeat(24)}==`, `sha512-${'A'.repeat(20)}Delo${'B'.repeat(24)}==`],
  ['base64 digest without the name', 'sha512-AbCdEf0123', 'sha512-AbCdEf0123'],
]

describe('rename rules', () => {
  it.each(TABLE)('%s', (_label, before, after) => {
    expect(rename(before)).toBe(after)
  })

  it('is idempotent on every row', () => {
    for (const [, , after] of TABLE) expect(rename(after)).toBe(after)
  })

  it('counts replacements per rule and guard matches that keep the name', () => {
    const applied = applyRules('Delo and delo and DELO_HOME and Delo Run on delo.run and delo.run' + ' ' + 'a'.repeat(40), 'a.md')
    expect(Object.fromEntries(applied.replaced)).toEqual({ lowercase: 1, capitalised: 1, uppercase: 1 })
    expect(Object.fromEntries(applied.guarded)).toEqual({ domain: 2, 'organisation-name': 1 })
  })

  it('keeps Chinese prose but renames identifiers on Chinese pages', () => {
    expect(applyRules('Delo 的笔记 DeloNotice delo-home', 'docs/x.zh.md').text).toBe('Delo 的笔记 DelorunNotice delorun-home')
  })

  it('has unique identifiers', () => {
    const ids = [...RULES, ...GUARDS].map(rule => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('fenced blocks in Chinese pages', () => {
  it('renames the product name inside a fenced block like the English page, and keeps it in prose', () => {
    const page = 'Delo 的输出：\n\n```text\nDelo did not run delo verify\n```\n\nDelo 结束。\n'
    expect(applyRules(page, 'docs/x.zh.md').text).toBe('Delo 的输出：\n\n```text\nDelorun did not run delorun verify\n```\n\nDelo 结束。\n')
    expect(applyRules('```text\nDelo did\n```\n', 'docs/x.md').text).toBe('```text\nDelorun did\n```\n')
  })

  it('treats a tilde fence and an unterminated fence the same way', () => {
    expect(applyRules('~~~\nDelo\n~~~\nDelo', 'a.zh.md').text).toBe('~~~\nDelorun\n~~~\nDelo')
    expect(applyRules('Delo\n```\nDelo', 'a.zh.md').text).toBe('Delo\n```\nDelorun')
  })
})

describe('path filters', () => {
  const filtered: ReplaceRule = { id: 'only-docs', description: 'x', pattern: /delo/gu, replacement: 'delorun', include: /^docs\//u, exclude: /\.zh\.md$/u }

  it('reaches only included, non-excluded paths', () => {
    expect(appliesTo(filtered, 'docs/a.md')).toBe(true)
    expect(appliesTo(filtered, 'src/a.md')).toBe(false)
    expect(appliesTo(filtered, 'docs/a.zh.md')).toBe(false)
    expect(appliesTo({}, 'any')).toBe(true)
  })

  it('skips a rule whose filter refuses the path', () => {
    expect(applyRules('delo', 'docs/a.md', [filtered], []).text).toBe('delorun')
    expect(applyRules('delo', 'src/a.md', [filtered], []).text).toBe('delo')
  })

  it('keeps the lockfile, recorded sessions and the rename tooling out of content edits', () => {
    expect(CONTENT_SKIP.test('pnpm-lock.yaml')).toBe(true)
    expect(CONTENT_SKIP.test('snapshots/acp/a/system-prompt.expected.md')).toBe(true)
    expect(CONTENT_SKIP.test('delo/apps/tools/src/rename/rules.ts')).toBe(true)
    expect(CONTENT_SKIP.test('delo/apps/tools/src/git.ts')).toBe(false)
    expect(CONTENT_SKIP.test('delo/release/production-keys.json')).toBe(true)
    expect(CONTENT_SKIP.test('snapshots/web/a/snapshot.yml')).toBe(false)
    expect(CONTENT_SKIP.test('.agents/notes/archived/x/delo-a.md')).toBe(true)
  })
})

describe('path renames', () => {
  it('renames names with the same rules', () => {
    expect(renamePath('delo/apps/cli/src/delo-bundles.ts')).toBe('delorun/apps/cli/src/delorun-bundles.ts')
    expect(renamePath('docs/model.md')).toBe('docs/model.md')
  })

  it('plans one last-segment rename per file and directory, deepest first, with the delo directory last', () => {
    const plan = planPathRenames(['delo/apps/a.ts', 'delo/apps/delo-b.ts', '.agents/skills/delo-x/SKILL.md', 'README.md'])
    expect(plan).toEqual([
      { from: '.agents/skills/delo-x', to: '.agents/skills/delorun-x' },
      { from: 'delo/apps/delo-b.ts', to: 'delo/apps/delorun-b.ts' },
      { from: 'delo', to: 'delorun' },
    ])
  })
})
