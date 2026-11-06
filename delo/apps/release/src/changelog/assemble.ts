/**
 * Assembles a release's changelog fragments into the `CHANGELOG.md` block and the release notes, then moves the
 * consumed fragments into `delo/changelog/releases/<version>/`. Run from the repository root:
 * `node_modules/.bin/tsx delo/apps/release/src/changelog/assemble.ts --version <version> [--dry-run] [--first-public-release]`.
 * `--dry-run` prints both documents and writes nothing. The command exits 1 with one line per refusal.
 *
 * The "From upstream" section names the upstream release in `delo/upstream-patches.json`, `upstream.ref`, and
 * lists the `From upstream` fragments after it. `CHANGELOG.md` is Delo's own file at the repository root: upstream's
 * tag has none, so the assembly creates it, and the first release that commits it adds its ledger entry.
 *
 * @module @delo/release/changelog/assemble
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readManifest } from '@delo/tools/src/check-fork-boundary.ts'
import { repositoryRoot } from '@delo/tools/src/git.ts'
import { fragmentPaths, parseFragment, SECTIONS, type Fragment, type Section } from './fragment.ts'
import { versionErrors } from './version.ts'

/** The changelog at the repository root, which the first assembly creates. */
export const CHANGELOG_PATH = 'CHANGELOG.md'

/** The folder of release notes and of the fragments each release consumed. */
export const RELEASES_DIR = 'delo/changelog/releases'

/** One assembled release, ready to write or to print. */
export interface Assembly {
  /** The release version. */
  readonly version: string
  /** The upstream release the version is based on. */
  readonly upstreamRef: string
  /** The `## <version>` block to prepend to `CHANGELOG.md`, ending with one newline. */
  readonly block: string
  /** The release notes file text. */
  readonly notes: string
  /** The fragments the release consumes, in the order they print. */
  readonly fragments: readonly Fragment[]
}

/**
 * The bullet lines of one section, with the upstream line first in `From upstream`.
 * @param section - the section to collect.
 * @param fragments - every fragment of the release.
 * @param upstreamRef - the upstream release the version is based on.
 * @returns the bullet lines; empty when the section has nothing to print.
 */
function sectionBullets(section: Section, fragments: readonly Fragment[], upstreamRef: string): string[] {
  const bullets = fragments.filter(fragment => fragment.section === section).flatMap(fragment => fragment.bullets)
  if (section !== 'From upstream') return bullets
  return [`- Based on DeepSeek Harness \`${upstreamRef}\`.`, ...bullets]
}

/**
 * The section blocks of a document: one heading per section that has bullets, in the fixed section order.
 * @param heading - the heading prefix of each section, such as `###`.
 * @param fragments - every fragment of the release.
 * @param upstreamRef - the upstream release the version is based on.
 * @returns the lines of every section block, each block followed by one blank line.
 */
function sectionLines(heading: string, fragments: readonly Fragment[], upstreamRef: string): string[] {
  return SECTIONS.flatMap((section) => {
    const bullets = sectionBullets(section, fragments, upstreamRef)
    return bullets.length === 0 ? [] : [`${heading} ${section}`, ...bullets, '']
  })
}

/**
 * Build a release's assembly from its version and fragments.
 * @param version - the release version, already validated.
 * @param upstreamRef - the upstream release the version is based on.
 * @param fragments - the parsed fragments the release consumes.
 * @returns the CHANGELOG block, the notes text and the fragments.
 */
export function renderAssembly(version: string, upstreamRef: string, fragments: readonly Fragment[]): Assembly {
  const block = [`## ${version}`, '', ...sectionLines('###', fragments, upstreamRef)].join('\n')
  const notes = [`# Delo ${version}`, '', ...sectionLines('##', fragments, upstreamRef)].join('\n')
  return { version, upstreamRef, block: `${block}\n`, notes: `${notes}\n`, fragments }
}

/**
 * Assemble a release from a repository's unreleased fragments.
 * @param root - the repository root.
 * @param version - the release version.
 * @param options - `firstPublicRelease` admits `1.0.0`.
 * @returns the assembly; nothing is written.
 * @throws Error listing every refusal, when the version is not accepted, a fragment does not parse, the upstream ledger
 * does not read, or the release already has notes or a changelog block.
 */
export function assembleRelease(root: string, version: string, options: { readonly firstPublicRelease: boolean }): Assembly {
  const errors = versionErrors(version, options.firstPublicRelease)
  const fragments: Fragment[] = []
  for (const path of fragmentPaths(root)) {
    const result = parseFragment(path, readFileSync(join(root, path), 'utf8'))
    if (result.ok) fragments.push(result.fragment)
    else errors.push(...result.errors.map(error => `${path}: ${error}`))
  }
  const notesPath = join(root, RELEASES_DIR, `${version}.md`)
  if (existsSync(notesPath) || existsSync(join(root, RELEASES_DIR, version))) errors.push(`release ${version} already has notes under ${RELEASES_DIR}`)
  const changelog = existsSync(join(root, CHANGELOG_PATH)) ? readFileSync(join(root, CHANGELOG_PATH), 'utf8') : ''
  if (changelog.split('\n').includes(`## ${version}`)) errors.push(`${CHANGELOG_PATH} already has a \`## ${version}\` block`)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return renderAssembly(version, readManifest(root).upstream.ref, fragments)
}

/**
 * Prepend a release block to the changelog text, after its `#` title.
 * @param existing - the current `CHANGELOG.md` text; empty when the file does not exist.
 * @param block - the `## <version>` block, ending with one newline.
 * @returns the new file text, with the block before the first release heading.
 */
export function prependBlock(existing: string, block: string): string {
  if (existing.trim() === '') return `# Changelog\n\n${block}`
  const lines = existing.split('\n')
  const first = lines.findIndex(line => line.startsWith('## '))
  if (first < 0) return `${existing.trimEnd()}\n\n${block}`
  const head = lines.slice(0, first).join('\n').trimEnd()
  return `${head}\n\n${block}\n${lines.slice(first).join('\n')}`
}

/**
 * Write an assembly: the notes, the changelog block, and the moved fragments.
 * @param root - the repository root.
 * @param assembly - the assembly to write.
 * @returns the repository-relative paths written, in order.
 */
export function writeAssembly(root: string, assembly: Assembly): string[] {
  const releaseDir = join(root, RELEASES_DIR, assembly.version)
  const changelogPath = join(root, CHANGELOG_PATH)
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''
  mkdirSync(releaseDir, { recursive: true })
  const notesRel = `${RELEASES_DIR}/${assembly.version}.md`
  writeFileSync(join(root, notesRel), assembly.notes)
  writeFileSync(changelogPath, prependBlock(existing, assembly.block))
  for (const fragment of assembly.fragments) {
    renameSync(join(root, fragment.path), join(releaseDir, basename(fragment.path)))
  }
  return [notesRel, CHANGELOG_PATH, ...assembly.fragments.map(fragment => `${RELEASES_DIR}/${assembly.version}/${basename(fragment.path)}`)]
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'first-public-release': { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.version === undefined) {
    console.error('assemble: pass --version <version>')
    return 2
  }
  const root = repositoryRoot(process.cwd())
  let assembly: Assembly
  try {
    assembly = assembleRelease(root, values.version, { firstPublicRelease: values['first-public-release'] })
  } catch (error) {
    console.error(`assemble: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  if (values['dry-run']) {
    console.log(`--- ${CHANGELOG_PATH} (block to prepend) ---\n${assembly.block}`)
    console.log(`--- ${RELEASES_DIR}/${assembly.version}.md ---\n${assembly.notes}`)
    console.log(`fragments to move: ${String(assembly.fragments.length)}`)
    return 0
  }
  for (const path of writeAssembly(root, assembly)) console.log(`assemble: wrote ${path}`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
