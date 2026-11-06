/**
 * Infrastructure gate: refuses identifiers of a deployment in the paths it scans: an IPv4 address outside the
 * documentation ranges, a tailnet name other than the `example` tailnet, and a cloud account ID. Loopback (127/8),
 * the unspecified and broadcast addresses are not identifiers of a deployment and are not refused. A finding on a line
 * upstream's copy of the file holds word for word passes, as in the secrets gate. A documented exception is listed in
 * `infrastructure.allowlist.json` by path and value. The runner passes staged paths at pre-commit; with no paths the
 * gate scans every path that differs from the pinned upstream commit. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/infrastructure.ts [paths...]`.
 *
 * @module @delo/tools/checks/gates/infrastructure
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { repositoryRoot } from '../../git.ts'
import { regularFiles, scanTarget, upstreamLines } from './paths.ts'

/** The allowlist of documented exceptions, relative to the repository root. */
export const ALLOWLIST_PATH = 'delo/apps/tools/src/checks/gates/infrastructure.allowlist.json'

/** The AWS documentation account ID; the examples of AWS's own documentation use it. */
const DOCUMENTATION_ACCOUNT = '123456789012'

/** The tailnet label that stands for an example tailnet, as in `*.example.ts.net`. */
const EXAMPLE_TAILNET = 'example'

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`(?<![\\d.])(${OCTET}(?:\\.${OCTET}){3})(?![\\d]|\\.\\d)`, 'gu')
const TAILNET = /(?<![\w-])((?:[a-z0-9-]+\.)*[a-z0-9-]+)\.ts\.net(?![\w-])/giu
const AWS_ARN_ACCOUNT = /\barn:aws[\w-]*:[^\s:'"]*:[^\s:'"]*:(\d{12}):/gu
const AWS_ECR_ACCOUNT = /\b(\d{12})\.dkr\.ecr\.[\w-]+\.amazonaws\.com\b/gu
const ACCOUNT_KEY = /\b(?:aws[_-]?account[_-]?id|account[_-]?id|accountid)["']?\s*[:=]\s*["']?(\d{12}|[0-9a-f]{32})\b/giu

const allowlistFile = z.strictObject({
  $comment: z.string().optional(),
  entries: z.array(z.strictObject({
    path: z.string().min(1),
    value: z.string().min(1),
    reason: z.string().min(1),
  })),
})

/** The allowlist file: the documented exceptions, each by its path and value. */
export type AllowlistFile = z.infer<typeof allowlistFile>

/** One identifier of a deployment that the gate refuses. */
export interface Finding {
  /** What the identifier is. */
  readonly kind: 'IPv4 address' | 'tailnet name' | 'cloud account ID'
  /** The identifier as the text states it. */
  readonly value: string
  /** The 1-based line that holds it. */
  readonly line: number
}

/**
 * Whether an IPv4 address is one the gate does not refuse: loopback, the unspecified and broadcast addresses, or an
 * address of RFC 5737's documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
 * @param address - a dotted-quad IPv4 address.
 * @returns true when the address is not an identifier of a deployment.
 */
export function isExemptIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  const [a = -1, b = -1, c = -1] = octets
  return a === 127
    || octets.every(octet => octet === 0)
    || octets.every(octet => octet === 255)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
}

/**
 * The identifiers of a deployment one line of text carries.
 * @param line - one line of text.
 * @returns the findings on that line, in order; empty when none.
 */
export function lineFindings(line: string, lineNumber: number): Finding[] {
  const findings: Finding[] = []
  for (const match of line.matchAll(IPV4)) {
    const address = match[1] ?? ''
    if (!isExemptIpv4(address)) findings.push({ kind: 'IPv4 address', value: address, line: lineNumber })
  }
  for (const match of line.matchAll(TAILNET)) {
    const labels = (match[1] ?? '').toLowerCase().split('.')
    if (labels[labels.length - 1] !== EXAMPLE_TAILNET) findings.push({ kind: 'tailnet name', value: `${match[1] ?? ''}.ts.net`, line: lineNumber })
  }
  for (const pattern of [AWS_ARN_ACCOUNT, AWS_ECR_ACCOUNT, ACCOUNT_KEY]) {
    for (const match of line.matchAll(pattern)) {
      const account = match[1] ?? ''
      if (account !== DOCUMENTATION_ACCOUNT) findings.push({ kind: 'cloud account ID', value: account, line: lineNumber })
    }
  }
  return findings
}

/**
 * Read and validate the allowlist file.
 * @param path - the absolute path of the allowlist file.
 * @returns the documented exceptions.
 * @throws Error when the file is missing, is not JSON, or does not match the allowlist schema.
 */
export function readAllowlist(path: string): AllowlistFile {
  return allowlistFile.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * The refused identifiers of one file's text.
 * @param path - the repository-relative path, which the allowlist matches.
 * @param text - the file's text; a binary file has none.
 * @param allowlist - the documented exceptions.
 * @param upstream - the lines of upstream's copy of the file, or undefined when upstream has no such file.
 * @returns one message per refused identifier, naming its location; empty when the file is clean.
 */
export function fileErrors(path: string, text: string, allowlist: AllowlistFile, upstream?: ReadonlySet<string>): string[] {
  if (text.includes('\0')) return []
  const allowed = new Set(allowlist.entries.map(entry => `${entry.path}\0${entry.value}`))
  return text.split('\n').flatMap((line, index) => {
    if (upstream?.has(line) === true) return []
    return lineFindings(line, index + 1)
      .filter(finding => !allowed.has(`${path}\0${finding.value}`))
      .map(finding => `${path}:${String(finding.line)}: ${finding.kind} ${finding.value} is an identifier of a deployment; use a documentation address or a placeholder, or list it in ${ALLOWLIST_PATH}`)
  })
}

async function main(argv: readonly string[]): Promise<number> {
  const root = repositoryRoot(process.cwd())
  const { paths, upstreamCommit } = scanTarget(root, argv)
  const allowlist = readAllowlist(join(root, ALLOWLIST_PATH))
  // The allowlist names the identifiers it permits, so the gate does not read it.
  const scanned = regularFiles(root, paths).filter(path => path !== ALLOWLIST_PATH)
  const errors = scanned.flatMap(path => fileErrors(
    path,
    readFileSync(join(root, path), 'utf8'),
    allowlist,
    upstreamLines(root, upstreamCommit, path),
  ))
  for (const error of errors) console.error(`gates:infrastructure: ${error}`)
  if (errors.length > 0) {
    console.error('gates:infrastructure: refused; replace each identifier with a documentation address or a placeholder')
    return 1
  }
  console.log(`gates:infrastructure: no deployment identifiers in the ${String(scanned.length)} file(s) checked`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
