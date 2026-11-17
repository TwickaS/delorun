/**
 * The text `delorun --help` prints: the commands in groups, each with a short phrase, the words the other help uses, and
 * the exit codes, wrapped to the terminal's width with a hanging indent. Each command's own options are in
 * [help](./help.ts).
 *
 * @module @delorun/cli/main-help
 */
import type { Style } from './style.ts'

/** The version a source checkout's manifest carries, which is no release. */
const SOURCE_VERSION = '0.0.0'

/** The widest line the main help writes, however wide the terminal is. */
export const HELP_WIDTH_LIMIT = 88

/** One command of the main help: its name and what it does in a phrase. */
type Entry = readonly [name: string, phrase: string]

/** The groups of the main help, in order. Every command in the table belongs to exactly one. */
export const HELP_GROUPS: readonly (readonly [title: string, entries: readonly Entry[]])[] = [
  ['Everyday', [['start', 'start Delorun, in the background or in this terminal'], ['open', 'open the studio in your browser'], ['stop', 'stop Delorun'], ['status', 'show whether Delorun is running'], ['logs', 'see where the logs are and what they say']]],
  ['Setup', [['setup', 'set Delorun up, or answer one question again; export and import a setup'], ['doctor', 'check that everything Delorun needs is in place'], ['update', 'install a newer release'], ['recover', 'go back after an update that went wrong']]],
  ['Phone', [['reach', 'use the studio from your phone, over your own Tailscale network'], ['devices', 'choose which devices may sign in']]],
  ['Safety', [['workspace', 'let a folder\'s chats run outside the sandbox, or start agents there'], ['agents', 'sign an added agent in, or see its plan limits'], ['mcp', 'answer the MCP servers that wait for you'], ['changes', 'review what plugins and edits want to change']]],
  ['Data', [['trash', 'bring back or delete chats and workspaces'], ['export', 'write a chat or workspace as a signed archive'], ['import', 'read a signed archive into this home'], ['import-home', 'copy a DeepSeek Harness home into this one']]],
  ['Advanced', [['verify', 'check this release against its signed manifest'], ['plugin', 'add, check and write plugins'], ['preview', 'turn a preview feature of the studio on or off'], ['headless', 'answer one task and exit']]],
]

/** The words the help uses, with what each means. */
const WORDS: readonly (readonly [word: string, meaning: string])[] = [
  ['home', 'the folder where Delorun keeps your chats and settings: ~/.delorun, or DELORUN_HOME'],
  ['profile', 'one named setup of Delorun on this computer: default, or DELORUN_PROFILE or --profile'],
  ['studio', 'the web page Delorun serves on this computer, where you chat'],
  ['workspace', 'a folder your chats work in'],
  ['full access', 'a workspace setting that lets chats run commands outside the sandbox'],
  ['reach', 'using the studio from your phone over your own Tailscale network'],
]

/**
 * Wrap text to a width, with the continuation lines indented under the text after the first line's lead.
 * @param lead - what starts the first line, such as `  home       `.
 * @param text - the words to wrap.
 * @param width - the widest line, in characters.
 * @returns the lines; the continuation lines start with as many spaces as `lead` is long.
 */
export function wrapWithHangingIndent(lead: string, text: string, width: number): string[] {
  const indent = ' '.repeat(lead.length)
  const lines: string[] = []
  let line = lead
  let empty = true
  for (const word of text.split(/\s+/u).filter(part => part !== '')) {
    if (!empty && line.length + 1 + word.length > width) {
      lines.push(line)
      line = indent
      empty = true
    }
    line += `${empty ? '' : ' '}${word}`
    empty = false
  }
  lines.push(line)
  return lines
}

/** What the main help is written from. */
export interface MainHelpRequest {
  /** The names of the commands in the table; each must belong to a group. */
  readonly commands: readonly string[]
  /** Delorun's version. */
  readonly version: string
  /** The terminal's width in columns; 80 when the output is not a terminal. */
  readonly columns: number
  /** The styles. */
  readonly style: Style
}

/**
 * The main help.
 * @param request - the commands, version, width and styles.
 * @returns the text, ending in a newline.
 * @throws {Error} when a command is in no group, or a group names a command the table does not have.
 */
export function mainHelp(request: MainHelpRequest): string {
  const { style } = request
  const grouped = HELP_GROUPS.flatMap(([, entries]) => entries.map(([name]) => name))
  const missing = request.commands.filter(name => !grouped.includes(name))
  const unknown = grouped.filter(name => !request.commands.includes(name))
  if (missing.length > 0 || unknown.length > 0) throw new Error(`the main help groups do not match the command table: ${[...missing.map(name => `${name} has no group`), ...unknown.map(name => `${name} is not a command`)].join('; ')}`)
  const width = Math.min(request.columns, HELP_WIDTH_LIMIT)
  const nameWidth = Math.max(...grouped.map(name => name.length))
  const lines = [
    `${style.badge()} ${request.version === SOURCE_VERSION ? 'source build' : request.version} ${style.dim('· the studio on your computer')}`,
    '',
    ...wrapWithHangingIndent('Usage: ', 'delorun [--profile <name>] [--foreground | --background]', width),
    ...wrapWithHangingIndent('       ', 'delorun <command> [options]', width),
    '',
    ...wrapWithHangingIndent('', 'With no command, delorun sets up a new home, or starts Delorun and opens the studio: --background keeps it running after you close the terminal and --foreground keeps it in this terminal; without either, setup\'s answer chooses (delorun setup background).', width),
  ]
  for (const [title, entries] of HELP_GROUPS) {
    lines.push('', style.command(title))
    for (const [name, phrase] of entries) {
      const lead = `  ${name.padEnd(nameWidth)}  `
      const [first = '', ...rest] = wrapWithHangingIndent(lead, phrase, width)
      lines.push(`  ${style.command(name)}${' '.repeat(nameWidth - name.length)}  ${first.slice(lead.length)}`, ...rest)
    }
  }
  lines.push('', ...wrapWithHangingIndent('', 'delorun <command> --help shows a command\'s options. delorun --version prints Delorun\'s and DSH\'s versions; --json prints them as one JSON line.', width))
  lines.push('', style.command('Words used here'))
  const wordWidth = Math.max(...WORDS.map(([word]) => word.length)) + 2
  for (const [word, meaning] of WORDS) lines.push(...wrapWithHangingIndent(`  ${word.padEnd(wordWidth)}`, meaning, width))
  lines.push('', ...wrapWithHangingIndent('', 'Exit codes: 0 done, 1 failed, 2 wrong command line, 3 Delorun is not running.', width), '')
  return lines.join('\n')
}
