import { describe, expect, it } from 'vitest'
import { BUILT_IN_CHECKS, EXCERPT_LIMIT, excerptOf, newLines } from '../src/risk.ts'
import { RISK_KINDS, type ReviewedFile, type ReviewInput, type RiskFinding, type RiskKind } from '../src/types.ts'

function source(path: string, after: string, before?: string): ReviewedFile {
  return before === undefined ? { path, status: 'added', dependency: false, after } : { path, status: 'modified', dependency: false, after, before }
}

function run(kind: RiskKind, input: ReviewInput): readonly RiskFinding[] {
  return BUILT_IN_CHECKS[RISK_KINDS.indexOf(kind)]!.check(input)
}

function linesFound(kind: RiskKind, path: string, lines: readonly string[]): readonly string[] {
  return run(kind, { files: [source(path, lines.join('\n'))] }).map(finding => finding.excerpt)
}

describe('built-in checks', () => {
  it('has one check per kind, in RISK_KINDS order', () => {
    expect(BUILT_IN_CHECKS.map(check => check.id)).toEqual(RISK_KINDS.map(kind => `built-in:${kind}`))
  })
})

describe('newLines', () => {
  it('reports the lines of after that before does not account for, counting repeats', () => {
    const lines = newLines(source('a.ts', 'same\nsame\nnew\r\nsame', 'same\r\nold\nsame'))
    expect(lines).toEqual([{ line: 3, text: 'new' }, { line: 4, text: 'same' }])
  })

  it('reads every line of an added file and none of a removed one', () => {
    expect(newLines(source('a.ts', 'one\ntwo'))).toEqual([{ line: 1, text: 'one' }, { line: 2, text: 'two' }])
    expect(newLines({ path: 'a.ts', status: 'removed', dependency: false, before: 'gone' })).toEqual([])
  })
})

describe('excerptOf', () => {
  it('trims a line and bounds it', () => {
    expect(excerptOf('   fetch(url)  ')).toBe('fetch(url)')
    const long = excerptOf(`  ${'x'.repeat(400)}`)
    expect(long).toHaveLength(EXCERPT_LIMIT)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('line checks', () => {
  it('report the file, the line in the new text, the check and the excerpt', () => {
    const findings = run('network', { files: [source('src/index.ts', 'const a = 1\nconst b = 2\n  await fetch(url)', 'const a = 1\nawait fetch(url)')] })
    expect(findings).toEqual([{ kind: 'network', check: 'built-in:network', file: 'src/index.ts', line: 3, excerpt: 'await fetch(url)' }])
  })

  it('do not report a line already in the text before the change', () => {
    expect(run('commands', { files: [source('src/index.ts', "import { spawn } from 'node:child_process'\nconst x = 1", "const x = 0\nimport { spawn } from 'node:child_process'")] })).toEqual([])
  })

  it('skip files they do not read and files below node_modules', () => {
    expect(run('network', { files: [source('README.md', 'fetch(url)'), source('src/shell.sh', 'curl $URL')] })).toEqual([])
    expect(run('network', { files: [{ path: 'node_modules/x/index.js', status: 'added', dependency: true, after: 'fetch(url)' }] })).toEqual([])
  })

  it('read every scanned extension', () => {
    const paths = ['a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.json', 'a.yaml', 'a.yml']
    expect(run('home-read', { files: paths.map(path => source(path, 'DELO_HOME')) }).map(finding => finding.file)).toEqual(paths)
  })
})

describe('consent-guard-sandbox', () => {
  it('finds guards, policies, presets, sandbox providers and guard plugins', () => {
    const lines = [
      'ctx.tools.guard(name, guard)',
      'ctx.tools?.restrict(names)',
      'ctx.approval.setPolicy(policy)',
      'ctx.approval.overrideOf(session)',
      'ctx.approval.request = async () => true',
      "ctx.permissionPresets.registerAuto('x', preset)",
      "ctx.permissionPresets.unset('x')",
      'ctx.sandbox.confine = command => command',
      'ctx.sandboxPolicy = open',
      "ctx.provide('sandbox')",
      "ctx.set('approval', service)",
      "super(ctx, 'permissionPresets')",
      'ctx.plugin(NoSandboxPlugin)',
      "ctx.plugin(await import('./consent-off.ts'))",
    ]
    expect(linesFound('consent-guard-sandbox', 'src/index.ts', lines)).toEqual(lines)
  })

  it('does not find ordinary use of the same services', () => {
    const lines = ['await ctx.approval.request(input)', 'ctx.sandbox.confine(command)', 'if (ctx.sandbox === undefined) return', "ctx.get('sandbox')", 'ctx.plugin(Weather)', "const row = { name: 'guard' }"]
    expect(linesFound('consent-guard-sandbox', 'src/index.ts', lines)).toEqual([])
  })

  it('finds a YAML row whose id or name names a guard', () => {
    expect(linesFound('consent-guard-sandbox', 'overlay.yml', ['- id: approval-off', '  name: Sandbox', 'other: consent'])).toEqual(['- id: approval-off', 'name: Sandbox'])
    expect(linesFound('consent-guard-sandbox', 'overlay.yaml', ['- id: weather', '  name: guard-rail'])).toEqual(['name: guard-rail'])
  })
})

describe('model-tool', () => {
  it('finds tool, executor, command and skill-provider registrations', () => {
    const lines = ['ctx.tools.register(tool)', 'ctx.tools.setExecutor(name, run)', 'ctx.commands?.register(command)', 'ctx.skills.registerProvider(provider)']
    expect(linesFound('model-tool', 'src/index.ts', lines)).toEqual(lines)
  })

  it('does not find other registrations', () => {
    expect(linesFound('model-tool', 'src/index.ts', ['ctx.on("ready", f)', 'registry.register(x)', 'ctx.tools.list()'])).toEqual([])
  })
})

describe('commands', () => {
  it('finds child processes, workers, the shell service and native addons', () => {
    const lines = [
      "import { spawn } from 'node:child_process'",
      "const cp = require('child_process')",
      "import { execa } from 'execa'",
      "import spawnIt from 'cross-spawn'",
      "const { Worker } = await import('node:worker_threads')",
      "spawn('ls')",
      "execSync('ls')",
      "cp.execFile('ls')",
      'await ctx.shell.run(command)',
      'this.ctx.subprocess.spawn(command)',
      'parent.subprocess.kill(id)',
      'process.dlopen(module, path)',
    ]
    expect(linesFound('commands', 'src/index.ts', lines)).toEqual(lines)
  })

  it('does not find regular expressions or words that merely contain the names', () => {
    expect(linesFound('commands', 'src/index.ts', ['const match = pattern.exec(text)', "const shell = 'bash'", 'respawn(x)', "import x from 'execa-like'"])).toEqual([])
  })
})

describe('network', () => {
  it('finds fetch, network modules and browser connection classes', () => {
    const lines = [
      'await fetch(url)',
      "import http from 'node:http'",
      "require('https')",
      "import { connect } from 'node:net'",
      "import tls from 'tls'",
      "import { createSocket } from 'node:dgram'",
      "import h2 from 'node:http2'",
      "import { request } from 'undici'",
      "const axios = require('axios')",
      "import got from 'got'",
      "import { fetch as f } from 'undici/fetch'",
      'new WebSocket(url)',
      'new XMLHttpRequest()',
      'new EventSource(url)',
    ]
    expect(linesFound('network', 'src/index.ts', lines)).toEqual(lines)
  })

  it('does not find names that merely contain the words', () => {
    expect(linesFound('network', 'src/index.ts', ['prefetch(items)', 'const got = 1', "import x from 'httpx'", 'const network = true'])).toEqual([])
  })
})

describe('home-read', () => {
  it('finds the home path, its variables and resolvers, profiles and secrets', () => {
    const lines = [
      "join(homedir(), '.delo', 'secrets')",
      'process.env.DELO_HOME',
      'process.env.DSH_HOME',
      'resolveDshHome()',
      'resolveDeloHome(env)',
      "join(homedir(), '.dsh')",
      "readFile('/x/profiles/default/package.json')",
      "readFile(`${home}/secrets/token`)",
      "join(home, 'secrets')",
    ]
    expect(linesFound('home-read', 'src/index.ts', lines)).toEqual(lines)
  })

  it('does not find a home directory alone or names that merely contain the words', () => {
    expect(linesFound('home-read', 'src/index.ts', ['join(homedir(), "work")', 'config.delo = 1', 'const dsh = 1', 'const secretsCount = 2'])).toEqual([])
  })
})

describe('dependency-or-build', () => {
  it('finds a dependency added or whose range changed, with its line in the new package.json', () => {
    const after = { name: 'p', dependencies: { kept: '^1.0.0', changed: '^2.0.0', added: '1.0.0' }, peerDependencies: { peer: '*' }, optionalDependencies: { opt: '1' } }
    const text = JSON.stringify(after, null, 2)
    const findings = run('dependency-or-build', {
      files: [source('package.json', text)],
      manifestBefore: { name: 'p', dependencies: { kept: '^1.0.0', changed: '^1.0.0', removed: '1' } },
      manifestAfter: after,
    })
    expect(findings.map(({ line, excerpt }) => ({ line, excerpt }))).toEqual([
      { line: 5, excerpt: 'dependencies.changed: "^2.0.0" (was "^1.0.0")' },
      { line: 6, excerpt: 'dependencies.added: "1.0.0"' },
      { line: 12, excerpt: 'optionalDependencies.opt: "1"' },
      { line: 9, excerpt: 'peerDependencies.peer: "*"' },
    ])
    expect(findings.every(finding => finding.file === 'package.json' && finding.check === 'built-in:dependency-or-build')).toBe(true)
  })

  it('finds an added postinstall and a changed build script, and no other script', () => {
    const findings = run('dependency-or-build', {
      files: [],
      manifestBefore: { scripts: { build: 'tsc', test: 'vitest' } },
      manifestAfter: { scripts: { build: 'tsc && node fetch.js', test: 'vitest run', postinstall: 'node setup.js' } },
    })
    expect(findings.map(finding => [finding.line, finding.excerpt])).toEqual([
      [undefined, 'scripts.build: "tsc && node fetch.js" (was "tsc")'],
      [undefined, 'scripts.postinstall: "node setup.js"'],
    ])
  })

  it('finds names bundled newly, and bundling everything', () => {
    expect(run('dependency-or-build', { files: [], manifestBefore: { bundleDependencies: ['a'] }, manifestAfter: { bundleDependencies: ['a', 'b', 3] } }).map(finding => finding.excerpt)).toEqual(['bundleDependencies.b: true'])
    expect(run('dependency-or-build', { files: [], manifestBefore: {}, manifestAfter: { bundledDependencies: true } }).map(finding => finding.excerpt)).toEqual(['bundledDependencies: true'])
    expect(run('dependency-or-build', { files: [], manifestBefore: { bundledDependencies: true }, manifestAfter: { bundledDependencies: true } })).toEqual([])
    expect(run('dependency-or-build', { files: [], manifestAfter: { bundledDependencies: false } })).toEqual([])
  })

  it('finds nothing for an unchanged, removed or absent manifest', () => {
    const manifest = { dependencies: { a: '1' }, scripts: { postinstall: 'x' } }
    expect(run('dependency-or-build', { files: [], manifestBefore: manifest, manifestAfter: structuredClone(manifest) })).toEqual([])
    expect(run('dependency-or-build', { files: [], manifestBefore: manifest })).toEqual([])
    expect(run('dependency-or-build', { files: [], manifestBefore: null, manifestAfter: ['not', 'a', 'manifest'] })).toEqual([])
  })

  it('leaves the line out when the new package.json text does not show the entry', () => {
    const manifestAfter = { dependencies: { a: '1' } }
    const withoutSection = run('dependency-or-build', { files: [source('package.json', '{}')], manifestAfter })
    const withoutKey = run('dependency-or-build', { files: [source('package.json', '{\n  "dependencies": {}\n}')], manifestAfter })
    const removed = run('dependency-or-build', { files: [{ path: 'package.json', status: 'removed', dependency: false, before: '{}' }], manifestAfter })
    expect([withoutSection, withoutKey, removed].map(findings => findings.map(finding => finding.line))).toEqual([[undefined], [undefined], [undefined]])
  })

  it('finds a node_modules change once per top-level package', () => {
    const dependencyFile = (path: string, status: ReviewedFile['status'] = 'modified'): ReviewedFile => ({ path, status, dependency: true })
    const findings = run('dependency-or-build', {
      files: [
        dependencyFile('node_modules/left-pad/index.js'),
        dependencyFile('node_modules/left-pad/package.json', 'added'),
        dependencyFile('node_modules/left-pad/node_modules/inner/x.js', 'removed'),
        dependencyFile('node_modules/@scope/pkg/lib/a.js'),
        dependencyFile('node_modules/@scope'),
        dependencyFile('node_modules'),
        dependencyFile('vendor/copied.js'),
        source('src/index.ts', 'const x = 1'),
      ],
    })
    expect(findings.map(finding => [finding.file, finding.excerpt, finding.line])).toEqual([
      ['node_modules/left-pad', 'node_modules/left-pad: 3 files changed', undefined],
      ['node_modules/@scope/pkg', 'node_modules/@scope/pkg: 1 file changed', undefined],
      ['node_modules/@scope', 'node_modules/@scope: 1 file changed', undefined],
      ['node_modules', 'node_modules: 1 file changed', undefined],
      ['vendor/copied.js', 'vendor/copied.js: 1 file changed', undefined],
    ])
  })
})
