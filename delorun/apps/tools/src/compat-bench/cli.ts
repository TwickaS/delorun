/**
 * The bench's command line. Run from the repository root:
 *
 * ```sh
 * node_modules/.bin/tsx delorun/apps/tools/src/compat-bench/cli.ts <command> ...
 * ```
 *
 * - `image build [--host delorun|delorun-prev|stock] [--commit <sha>]`
 * - `run <package>[@<version>] | ./<folder> | --git <url>#<ref> [--host delorun|stock|both] [--out <dir>] [--exercise <file>] [--secret-env-file <path>]`
 * - `baseline [--host delorun|stock]`
 * - `fixtures <dir>`: write the five fixture plugins
 * - `card validate <card.json>` and `card render <card.json> [--public]`
 * - `table <cards dir>` and `board <cards dir>`
 *
 * Exit codes: 0 done, 1 the work failed, 2 usage.
 *
 * @module @delorun/tools/compat-bench/cli
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { downloadsFor, rankCauses, renderBoard } from './board.ts'
import { renderCard, validateCard } from './card.ts'
import { loadLatestCards } from './cards-dir.ts'
import { writeFixtures } from './fixtures.ts'
import { buildImage } from './images.ts'
import { runBench, runBaseline } from './runner.ts'
import type { Observer } from './observer.ts'
import { renderTable } from './table.ts'

const USAGE = [
  'usage: cli.ts image build [--host delorun|delorun-prev|stock] [--commit <sha>]',
  '       cli.ts run <package>[@<version>] | ./<folder> | --git <url>#<ref> [--host delorun|stock|both] [--out <dir>] [--exercise <file>] [--secret-env-file <path>] [--privacy] [--commit <sha>]',
  '       cli.ts baseline [--host delorun|stock]',
  '       cli.ts fixtures <dir>',
  '       cli.ts card validate <card.json> | card render <card.json> [--public]',
  '       cli.ts table <cards dir> | board <cards dir>',
].join('\n')

/** Where runs are written unless `--out` says otherwise. */
export const DEFAULT_OUT = join(homedir(), '.cache', 'delorun', 'compat-bench', 'runs')

/**
 * Run the command line.
 * @param argv - the arguments after the script name.
 * @param io - where output goes; the process's own by default.
 * @returns the exit code.
 */
export async function main(argv: readonly string[], io: { readonly out: (text: string) => void, readonly err: (text: string) => void } = { out: text => process.stdout.write(text), err: text => process.stderr.write(text) }): Promise<number> {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
  let parsed: ReturnType<typeof parseArgs<{ options: { host: { type: 'string' }, commit: { type: 'string' }, git: { type: 'string' }, out: { type: 'string' }, exercise: { type: 'string' }, 'secret-env-file': { type: 'string' }, public: { type: 'boolean' }, privacy: { type: 'boolean' } }, allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: { host: { type: 'string' }, commit: { type: 'string' }, git: { type: 'string' }, out: { type: 'string' }, exercise: { type: 'string' }, 'secret-env-file': { type: 'string' }, public: { type: 'boolean' }, privacy: { type: 'boolean' } } })
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`)
    return 2
  }
  const { values, positionals } = parsed
  const [command, ...rest] = positionals
  if (command === 'image' && rest[0] === 'build') {
    const host = values.host ?? 'delorun'
    if (host === 'helper') {
      const module = await import(new URL('./privacy/helper/image.ts', import.meta.url).href).catch(() => undefined) as { buildHelperImage?: () => Promise<string> } | undefined
      if (module?.buildHelperImage === undefined) { io.err('the helper image is built by the privacy lane, whose code is not in this tree\n'); return 2 }
      io.out(`${await module.buildHelperImage()}\n`)
      return 0
    }
    if (host !== 'delorun' && host !== 'delorun-prev' && host !== 'stock') {
      io.err(`unknown host ${host}\n${USAGE}\n`)
      return 2
    }
    const tag = await buildImage({ repository, host, ...(values.commit === undefined ? {} : { commit: values.commit }) }, line => io.err(`${line}\n`))
    io.out(`${tag}\n`)
    return 0
  }
  if (command === 'run' || command === 'baseline') {
    const host = values.host ?? (command === 'baseline' ? 'delorun' : 'both')
    if (host !== 'delorun' && host !== 'stock' && host !== 'both') { io.err(`unknown host ${host}\n${USAGE}\n`); return 2 }
    const hosts = host === 'both' ? (['delorun', 'stock'] as const) : ([host] as const)
    const outRoot = values.out === undefined ? DEFAULT_OUT : resolve(values.out)
    const observers: Observer[] = []
    if (values.privacy === true) {
      const module = await import(new URL('./privacy/observer.ts', import.meta.url).href).catch(() => undefined) as { createPrivacyObserver?: () => Observer } | undefined
      if (module?.createPrivacyObserver === undefined) { io.err('--privacy needs the privacy lane\'s observer, which is not in this tree\n'); return 2 }
      observers.push(module.createPrivacyObserver())
    }
    let code = 0
    for (const each of hosts) {
      if (command === 'baseline') {
        const baseline = await runBaseline({ repository, host: each, outRoot, observers, ...(values.commit === undefined ? {} : { commit: values.commit }), log: line => io.err(`${line}\n`) })
        io.out(`${baseline.path}\n`)
        continue
      }
      const source = values.git !== undefined ? { kind: 'git' as const, spec: values.git } : rest[0]?.startsWith('.') === true || rest[0]?.startsWith('/') === true ? { kind: 'folder' as const, spec: resolve(rest[0]) } : rest[0] !== undefined ? { kind: 'npm' as const, spec: rest[0] } : undefined
      if (source === undefined) { io.err(`run needs a package\n${USAGE}\n`); return 2 }
      const result = await runBench({ repository, host: each, source, outRoot, observers, ...(values.commit === undefined ? {} : { commit: values.commit }), log: line => io.err(`${line}\n`), ...(values.exercise === undefined ? {} : { exercise: resolve(values.exercise) }), ...(values['secret-env-file'] === undefined ? {} : { secretEnvFile: resolve(values['secret-env-file']) }) })
      io.out(`${join(result.dir, 'card.json')}\n`)
      if (result.card.verdict === 'blocked') code = 1
    }
    return code
  }
  if (command === 'fixtures' && rest[0] !== undefined) {
    mkdirSync(resolve(rest[0]), { recursive: true })
    for (const [name, dir] of writeFixtures(resolve(rest[0]))) io.out(`${name} ${dir}\n`)
    return 0
  }
  if (command === 'card' && (rest[0] === 'validate' || rest[0] === 'render') && rest[1] !== undefined) {
    const result = validateCard(JSON.parse(readFileSync(rest[1], 'utf8')) as unknown)
    if (!result.ok) { io.err(`${result.problems.join('\n')}\n`); return 1 }
    if (rest[0] === 'validate') { io.out('valid\n'); return 0 }
    io.out(renderCard(result.card, { public: values.public === true }))
    return 0
  }
  if ((command === 'table' || command === 'board') && rest[0] !== undefined) {
    const cards = loadLatestCards(resolve(rest[0]), line => io.err(`skipped ${line}\n`)).map(each => each.card)
    io.out(command === 'table' ? renderTable(cards) : renderBoard(rankCauses(cards, await downloadsFor(cards))))
    return 0
  }
  io.err(`${USAGE}\n`)
  return 2
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error: unknown) => {
    process.stderr.write(`compat-bench: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
