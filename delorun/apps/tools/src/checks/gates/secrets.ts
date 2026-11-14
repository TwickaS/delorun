/**
 * Secrets gate: refuses a token-shaped string, a private key or a file named like a secrets file in the paths it
 * scans. A finding on a line upstream's copy of the file holds word for word is upstream's, such as a test's fake
 * credential, and passes: a secret reaches the fork only through a line it adds. Findings print with their values
 * masked. The runner passes staged paths at pre-commit; with no paths the gate scans every path that differs from
 * the pinned upstream commit. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/secrets.ts [paths...]`.
 *
 * @module @delorun/tools/checks/gates/secrets
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createEngine } from '@secretlint/node'
import { z } from 'zod'
import { repositoryRoot } from '../../git.ts'
import { regularFiles, scanTarget, upstreamLines } from './paths.ts'

/**
 * The rules: secretlint's recommended preset, DeepSeek's key shape, and the names of files that hold secrets.
 * Masking hides a pattern's name in the report along with the value.
 */
const CONFIG = {
  rules: [
    { id: '@secretlint/secretlint-rule-preset-recommend' },
    {
      id: '@secretlint/secretlint-rule-pattern',
      options: {
        patterns: [
          { name: 'DeepSeek API key', patterns: ['/\\bsk-[0-9a-f]{32}\\b/'] },
          { name: 'secrets file; keep it in ~/.config/delorun, outside the checkout', filePathGlobs: ['**/.env', '**/.env.*', '**/*.vars', '**/*.pem', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*'] },
        ],
      },
    },
  ],
}

/** One finding as secretlint's JSON formatter reports it, its message already masked. */
const Finding = z.object({ message: z.string(), ruleId: z.string(), loc: z.object({ start: z.object({ line: z.number(), column: z.number() }) }) })
const Report = z.array(z.object({ filePath: z.string(), messages: z.array(Finding) }))

/**
 * Scan files for secrets.
 * @param root - the directory the paths are relative to.
 * @param paths - the paths to scan; symbolic links and directories among them are skipped.
 * @param upstreamLinesOf - the lines of upstream's copy of a path, or undefined for a path upstream does not have.
 * @returns whether no secret sits on a line the fork adds, and the masked report when one does.
 */
export async function scanSecrets(
  root: string,
  paths: readonly string[],
  upstreamLinesOf: (path: string) => ReadonlySet<string> | undefined,
): Promise<{ readonly ok: boolean; readonly output: string }> {
  const files = regularFiles(root, paths)
  if (files.length === 0) return { ok: true, output: '' }
  const engine = await createEngine({ cwd: root, configFileJSON: CONFIG, formatter: 'json', color: false, maskSecrets: true })
  const result = await engine.executeOnFiles({ filePathList: files.map(path => join(root, path)) })
  const report: string[] = []
  for (const file of Report.parse(JSON.parse(result.output))) {
    const path = relative(root, file.filePath)
    const upstream = upstreamLinesOf(path)
    const lines = upstream === undefined ? [] : readFileSync(file.filePath, 'utf8').split('\n')
    const own = file.messages.filter(finding => upstream === undefined || !upstream.has(lines[finding.loc.start.line - 1] ?? ''))
    if (own.length === 0) continue
    report.push(path, ...own.map(finding => `  ${String(finding.loc.start.line)}:${String(finding.loc.start.column)}  error  ${finding.message}  ${finding.ruleId}`), '')
  }
  return report.length === 0 ? { ok: true, output: '' } : { ok: false, output: report.join('\n') }
}

async function main(argv: readonly string[]): Promise<number> {
  const root = repositoryRoot(process.cwd())
  const { paths, upstreamCommit } = scanTarget(root, argv)
  const { ok, output } = await scanSecrets(root, paths, path => upstreamLines(root, upstreamCommit, path))
  if (!ok) {
    console.error(output)
    console.error('gates:secrets: refused; remove each finding above, and keep local secrets in ~/.config/delorun (AGENTS.md, Secrets)')
    return 1
  }
  console.log(`gates:secrets: none in the ${String(regularFiles(root, paths).length)} file(s) checked`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
