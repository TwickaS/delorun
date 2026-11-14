import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { DOC_CHECKS, outcome, type DocCheck } from '../../src/checks/gates/docs.ts'
import { REPO, runTsx } from './support.ts'

/**
 * The upstream scripts a fixture needs: the named scripts and every script they import by a relative path.
 * @param names - the script file names, such as `verify-md-wrap.ts`.
 * @returns the names of the scripts to copy, in discovery order.
 */
function scriptClosure(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const pending = [...names]
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    for (const match of readFileSync(join(REPO, 'scripts', name), 'utf8').matchAll(/from '\.\/([^']+)'/gu)) pending.push(match[1] ?? '')
  }
  return [...seen]
}

/**
 * A temporary tree that holds copies of upstream's documentation scripts and the given files, removed when the test
 * ends. The scripts run unchanged; the copies stand in for the repository's own, so the planted files are the only
 * documentation the scripts see.
 * @param test - the running test.
 * @param scripts - the script file names to run.
 * @param files - the repository-relative files to write, such as `delorun/docs/guide/a.md`.
 * @returns the tree's root.
 */
function fixture(test: TestContext, scripts: readonly string[], files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'delorun-docs-gate-'))
  test.onTestFinished(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const name of scriptClosure(scripts)) copyFileSync(join(REPO, 'scripts', name), join(root, 'scripts', name))
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/**
 * Run one copied upstream script in a fixture.
 * @param root - the fixture's root.
 * @param name - the script's file name.
 * @param args - the command-line arguments.
 * @returns the exit status and output.
 */
function run(root: string, name: string, args: readonly string[] = []): { status: number; output: string } {
  return runTsx(root, join(root, 'scripts', name), args)
}

/** A bilingual page pair: the English page links to its Chinese counterpart and the reverse, as Delorun's pages do. */
function pair(body: string): Record<string, string> {
  return {
    'delorun/docs/guide/a.md': `# A\n\nEnglish | [中文](a.zh.md)\n\n${body}\n`,
    'delorun/docs/guide/a.zh.md': `# A\n\n[English](a.md) | 中文\n\n${body}\n`,
  }
}

const PAIRING_MANIFEST = { 'scripts/translation-pairing.manifest.json': '{"excluded": []}\n' }

describe('the documentation gate\'s upstream checks, on planted violations in fixture trees', () => {
  it('refuses a Delorun page without its Chinese pair, and passes a complete pair whose record is recorded', (test) => {
    const bare = fixture(test, ['verify-translation-pairing.ts'], {
      ...PAIRING_MANIFEST,
      'delorun/docs/guide/a.md': '# A\n\nAlone.\n',
    })
    const missing = run(bare, 'verify-translation-pairing.ts')
    expect(missing.status).toBe(1)
    expect(missing.output).toContain('delorun/docs/guide/a.md: in-scope documentation must merge bilingual')

    const paired = fixture(test, ['verify-translation-pairing.ts'], { ...PAIRING_MANIFEST, ...pair('Shared text.') })
    expect(run(paired, 'verify-translation-pairing.ts', ['--write', '--all']).status).toBe(0)
    expect(run(paired, 'verify-translation-pairing.ts').status).toBe(0)
  }, 60_000)

  it('refuses a consistency record that no longer matches its English page', (test) => {
    const root = fixture(test, ['verify-translation-pairing.ts'], { ...PAIRING_MANIFEST, ...pair('Shared text.') })
    expect(run(root, 'verify-translation-pairing.ts', ['--write', '--all']).status).toBe(0)
    writeFileSync(join(root, 'delorun/docs/guide/a.md'), '# A\n\nEnglish | [中文](a.zh.md)\n\nEdited text.\n')
    const stale = run(root, 'verify-translation-pairing.ts')
    expect(stale.status).toBe(1)
    expect(stale.output).toContain('out of sync')
  }, 60_000)

  it('refuses a budgeted Delorun page over its ceiling, and passes it at the ceiling', (test) => {
    const page = { 'delorun/docs/guide/a.md': '# A\n\none two three four five six seven eight nine ten\n' }
    const over = fixture(test, ['verify-doc-budgets.ts'], {
      ...page,
      'scripts/doc-budgets.manifest.json': '{"delorun/docs/guide/a.md": 5}\n',
    })
    const failed = run(over, 'verify-doc-budgets.ts')
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('delorun/docs/guide/a.md: ')
    expect(failed.output).toContain('exceeds the 5-word ceiling')

    const within = fixture(test, ['verify-doc-budgets.ts'], {
      ...page,
      'scripts/doc-budgets.manifest.json': '{"delorun/docs/guide/a.md": 12}\n',
    })
    expect(run(within, 'verify-doc-budgets.ts').status).toBe(0)
  }, 60_000)

  it('refuses a Delorun paragraph wrapped across lines, and passes one line per paragraph', (test) => {
    const wrapped = fixture(test, ['verify-md-wrap.ts'], { 'delorun/docs/guide/a.md': '# A\n\nA paragraph wrapped\nacross two lines.\n' })
    const failed = run(wrapped, 'verify-md-wrap.ts')
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('delorun/docs/guide/a.md:3')

    const flat = fixture(test, ['verify-md-wrap.ts'], { 'delorun/docs/guide/a.md': '# A\n\nA paragraph on one line.\n' })
    expect(run(flat, 'verify-md-wrap.ts').status).toBe(0)
  }, 60_000)

  it('refuses a relative link to a missing Delorun page, and passes a link to one that exists', (test) => {
    const broken = fixture(test, ['verify-md-links.ts'], {
      'delorun/docs/guide/a.md': '# A\n\n[gone](missing.md)\n',
    })
    const failed = run(broken, 'verify-md-links.ts')
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('delorun/docs/guide/a.md:3  missing.md  (target does not exist)')

    const resolved = fixture(test, ['verify-md-links.ts'], {
      'delorun/docs/guide/a.md': '# A\n\n[there](b.md)\n',
      'delorun/docs/guide/b.md': '# B\n',
    })
    expect(run(resolved, 'verify-md-links.ts').status).toBe(0)
  }, 60_000)

  it('refuses a TypeScript fence in a Delorun page that does not compile, and passes one that does', (test) => {
    const compilerOptions = { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2024', types: [] }
    const fence = (value: string): string => ['# A', '', '```ts', `const value: number = ${value}`, '```', ''].join('\n')
    const broken = fixture(test, ['doc-typecheck.ts', 'doc-typecheck-paths.ts'], {
      'package.json': '{"version": "0.0.0"}\n',
      'tsconfig.host.json': JSON.stringify({ compilerOptions, references: [] }),
      'delorun/docs/guide/a.md': fence("'text'"),
    })
    const failed = run(broken, 'doc-typecheck.ts')
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('documentation code blocks failed to compile')
    expect(failed.output).toContain('delorun/docs/guide/a.md')

    const sound = fixture(test, ['doc-typecheck.ts', 'doc-typecheck-paths.ts'], {
      'package.json': '{"version": "0.0.0"}\n',
      'tsconfig.host.json': JSON.stringify({ compilerOptions, references: [] }),
      'delorun/docs/guide/a.md': fence('1'),
    })
    expect(run(sound, 'doc-typecheck.ts').status).toBe(0)
  }, 120_000)
})

describe('the documentation gate\'s verdicts', () => {
  it('reports a report-only check that exits non-zero, and does not fail a normal check that does', () => {
    const reportOnly: DocCheck = { title: 'bilingual pairs', scripts: [], reportOnly: true }
    const normal: DocCheck = { title: 'word budgets', scripts: [] }
    expect(outcome(reportOnly, 1)).toBe('reported')
    expect(outcome(reportOnly, 0)).toBe('passed')
    expect(outcome(normal, 1)).toBe('failed')
    expect(outcome(normal, 0)).toBe('passed')
  })

  it('marks exactly one upstream check report-only, the bilingual pairs check', () => {
    expect(DOC_CHECKS.filter((check) => check.reportOnly === true).map((check) => check.title)).toEqual(['bilingual pairs'])
  })
})
